"""Local, offline SAM 2 image-mask worker. JSON lines in/out; no HTTP server.

This worker is deliberately not connected to the production workbench until
the real-image quality gate passes. It returns masks, never generated RGB.
"""
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / ".local/ui-segmentation/model"
MAX_EDGE = 8192
MAX_IMAGE_BYTES = 24 * 1024 * 1024


def checked_box(bounds, width, height):
    values = [bounds.get(key) for key in ("x", "y", "width", "height")]
    if any(isinstance(value, bool) or not isinstance(value, int) for value in values):
        raise ValueError("Bounds must be integer source-image pixels")
    x, y, w, h = values
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > width or y + h > height:
        raise ValueError("Bounds are outside the source image")
    return x, y, w, h


def region_for_box(bounds, width, height, mode="local"):
    x, y, w, h = checked_box(bounds, width, height)
    if mode == "full":
        return 0, 0, width, height
    if mode != "local":
        raise ValueError("Region mode must be local or full")
    pad = max(64, math.ceil(max(w, h) * 0.2))
    return max(0, x - pad), max(0, y - pad), min(width, x + w + pad), min(height, y + h + pad)


def png_base64(image):
    target = io.BytesIO()
    image.save(target, format="PNG")
    return base64.b64encode(target.getvalue()).decode("ascii")


def decode_source(encoded):
    from PIL import Image
    if not isinstance(encoded, str) or len(encoded) > 34 * 1024 * 1024:
        raise ValueError("Missing or oversized source image")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as error:
        raise ValueError("Invalid image base64") from error
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Source image exceeds 24 MB")
    image = Image.open(io.BytesIO(raw))
    if image.format not in ("PNG", "JPEG", "WEBP"):
        raise ValueError("Only PNG, JPEG and WebP are supported")
    if not (0 < image.width <= MAX_EDGE and 0 < image.height <= MAX_EDGE):
        raise ValueError("Source image dimensions exceed 8192 pixels")
    image.load()
    # The worker does not rotate, crop, or normalize the reference coordinates.
    return image.convert("RGB"), hashlib.sha256(raw).hexdigest()


class Runtime:
    def __init__(self):
        self.model = None
        self.processor = None
        self.device = None
        self.fallback_reason = ""

    def status(self):
        import torch
        available = torch.backends.mps.is_available()
        return {"model": "facebook/sam2.1-hiera-tiny", "modelReady": (MODEL_DIR / "model.safetensors").is_file(),
                "loaded": self.model is not None, "mpsAvailable": available,
                "device": self.device or ("mps" if available else "cpu"),
                "fallbackReason": self.fallback_reason, "torchVersion": torch.__version__}

    def load(self, requested="auto"):
        import torch
        from transformers import Sam2Model, Sam2Processor
        if requested not in ("auto", "cpu", "mps"):
            raise ValueError("Unsupported device")
        if not (MODEL_DIR / "model.safetensors").is_file():
            raise ValueError("SAM 2.1 Tiny is not installed; run the setup script first")
        device = "cpu" if requested == "cpu" else "mps" if torch.backends.mps.is_available() else "cpu"
        if requested != "cpu" and device == "cpu":
            self.fallback_reason = "MPS is unavailable in this process; using CPU"
        if self.model is None:
            self.processor = Sam2Processor.from_pretrained(MODEL_DIR, local_files_only=True)
            self.model = Sam2Model.from_pretrained(MODEL_DIR, local_files_only=True, attn_implementation="eager")
            self.model.eval()
        if self.device != device:
            self.model.to(device)
            self.device = device

    def predict(self, source, bounds, region_mode):
        import numpy as np
        import torch
        from PIL import Image
        x, y, w, h = checked_box(bounds, source.width, source.height)
        left, top, right, bottom = region_for_box(bounds, source.width, source.height, region_mode)
        region = source.crop((left, top, right, bottom))
        local_box = [x - left, y - top, x + w - left, y + h - top]
        inputs = self.processor(images=region, input_boxes=[[local_box]], return_tensors="pt").to(self.device)
        with torch.inference_mode():
            output = self.model(**inputs, multimask_output=True)
        masks = self.processor.post_process_masks(
            output.pred_masks.detach().cpu(), inputs["original_sizes"].detach().cpu(), binarize=False
        )[0][0]
        scores = output.iou_scores.detach().cpu()[0][0].tolist()
        result = []
        for index, logits in enumerate(masks):
            values = (logits.numpy() > 0).astype(np.uint8) * 255
            if values.shape != (bottom - top, right - left):
                raise ValueError("Model mask dimensions do not match the source region")
            mask = Image.fromarray(values)
            nonzero = mask.getbbox()
            selected = int(np.count_nonzero(values))
            warnings = []
            if not selected:
                warnings.append("empty-mask")
            if selected > w * h * 1.5:
                warnings.append("mask-much-larger-than-prompt")
            if region_mode == "local" and selected and (values[0].any() or values[-1].any() or values[:, 0].any() or values[:, -1].any()):
                warnings.append("mask-touches-context-boundary")
            result.append({"candidate": index, "modelScore": float(scores[index]), "maskBase64": png_base64(mask),
                           "maskBounds": {"x": left, "y": top, "width": region.width, "height": region.height},
                           "contentBounds": None if nonzero is None else {"x": left + nonzero[0], "y": top + nonzero[1],
                               "width": nonzero[2] - nonzero[0], "height": nonzero[3] - nonzero[1]},
                           "selectedPixels": selected, "warnings": warnings})
        return sorted(result, key=lambda item: item["modelScore"], reverse=True)

    def segment(self, request):
        import torch
        started = time.perf_counter()
        source, source_hash = decode_source(request.get("imageBase64"))
        assets = request.get("assets")
        if not isinstance(assets, list) or not 1 <= len(assets) <= 120:
            raise ValueError("Supply between 1 and 120 assets")
        for asset in assets:
            checked_box(asset.get("bounds", {}), source.width, source.height)
        self.load(request.get("device", "auto"))
        loaded = time.perf_counter()
        results = []
        for asset in assets:
            item_started = time.perf_counter()
            try:
                candidates = self.predict(source, asset["bounds"], request.get("regionMode", "local"))
            except (RuntimeError, NotImplementedError) as error:
                message = str(error)
                if self.device != "mps" or not any(term in message.lower() for term in ("mps", "metal", "not implemented", "out of memory")):
                    raise
                self.model.to("cpu")
                self.device = "cpu"
                self.fallback_reason = message[:400]
                torch.mps.empty_cache()
                candidates = self.predict(source, asset["bounds"], request.get("regionMode", "local"))
            results.append({"id": asset.get("id"), "promptBounds": asset["bounds"], "candidates": candidates,
                            "elapsedMs": round((time.perf_counter() - item_started) * 1000), "device": self.device})
        return {"source": {"width": source.width, "height": source.height, "sha256": source_hash}, "assets": results,
                "device": self.device, "fallbackReason": self.fallback_reason,
                "loadMs": round((loaded - started) * 1000), "elapsedMs": round((time.perf_counter() - started) * 1000)}


def main():
    runtime = Runtime()
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request.get("op") == "status":
                result = runtime.status()
            elif request.get("op") == "segment":
                result = runtime.segment(request)
            elif request.get("op") == "validate-restore":
                import numpy as np
                source, source_hash = decode_source(request.get("imageBase64"))
                mask, _ = decode_source(request.get("maskBase64"))
                if source.size != mask.size or source.size != (request.get("width"), request.get("height")):
                    raise ValueError("Restore mask and source dimensions must match")
                array = np.asarray(mask.convert("L"))
                if not np.isin(array, (0, 255)).all() or not np.any(array == 255):
                    raise ValueError("Restore mask must contain a nonempty, hard white region")
                result = {"sourceHash": source_hash, "pixels": int(np.count_nonzero(array))}
            else:
                raise ValueError("Unknown operation")
            response = {"id": request.get("id"), "result": result}
        except Exception as error:
            response = {"id": request.get("id"), "error": {"type": type(error).__name__, "message": str(error)[:1500]}}
        print(json.dumps(response, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
