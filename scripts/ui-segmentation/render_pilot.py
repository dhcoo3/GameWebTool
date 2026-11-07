"""Export all candidates, native-pixel cutouts and review contact sheets."""
import json
from pathlib import Path
import sys
import numpy as np
from PIL import Image, ImageDraw
from pixels import place_mask, source_rgba, visible_ownership


def checker(size):
    yy, xx = np.indices((size[1], size[0]))
    values = np.where((xx // 16 + yy // 16) % 2, 180, 225).astype(np.uint8)
    return Image.fromarray(np.dstack([values, values, values, np.full_like(values, 255)]))


def main():
    directory = Path(sys.argv[1] if len(sys.argv) > 1 else "output/ui-segmentation-pilot")
    report = json.loads((directory / "pilot-results.json").read_text())
    source = Image.open(report["source"]).convert("RGBA")
    source_array = np.array(source)
    validation = {"pixelChecks": [], "warning": "Exact reassembly verifies pixel bookkeeping only, not semantic segmentation accuracy."}
    for run in report["runs"]:
        mode = run["regionMode"]
        top_masks = {}
        for asset in run["assets"]:
            bounds = asset["promptBounds"]
            x, y, w, h = (bounds[key] for key in ("x", "y", "width", "height"))
            window = (max(0, x - 16), max(0, y - 16), min(source.width, x + w + 16), min(source.height, y + h + 16))
            pw, ph = window[2] - window[0], window[3] - window[1]
            sheet = Image.new("RGB", (pw * 4, ph + 60), "#e9edf1")
            draw = ImageDraw.Draw(sheet)
            sheet.paste(source.crop(window).convert("RGB"), (0, 60))
            draw.text((10, 10), f"SOURCE / {asset['id']} / {mode}", fill="black")
            draw.text((10, 28), "Visually calibrated box; native pixel scale", fill="black")
            for rank, candidate in enumerate(asset["candidates"]):
                mask = place_mask(Image.open(directory / candidate["file"]), candidate["maskBounds"], source.size)
                cutout = source_rgba(source, mask)
                content = mask.getbbox()
                crop_file = f"{mode}-{asset['id']}-{candidate['candidate']}.png"
                if content:
                    cutout.crop(content).save(directory / crop_file)
                exact = bool(np.array_equal(np.asarray(cutout)[:, :, :3][np.asarray(mask) == 255], source_array[:, :, :3][np.asarray(mask) == 255]))
                validation["pixelChecks"].append({"file": crop_file, "rgbExact": exact, "cropBounds": content})
                tile = checker((pw, ph))
                tile.alpha_composite(cutout.crop(window))
                sx = (rank + 1) * pw
                sheet.paste(tile.convert("RGB"), (sx, 60))
                draw.text((sx + 10, 10), f"Rank {rank + 1} / candidate {candidate['candidate']}", fill="black")
                draw.text((sx + 10, 28), f"Model score {candidate['modelScore']:.3f} / RGB exact: {exact}", fill="black")
                if rank == 0:
                    top_masks[asset["id"]] = mask
                    cutout.crop(window).save(directory / f"{mode}-{asset['id']}-best.png")
            sheet.save(directory / f"{mode}-{asset['id']}-review.png")
        ids = ["login-button", "title-ornament", "outer-panel"]
        visible, residual = visible_ownership([top_masks[key] for key in ids])
        rebuilt = source_rgba(source, residual)
        # No complete original hidden below: the residual has holes at all
        # extracted pixels; parent layers also exclude all extracted children.
        for identifier, mask in reversed(list(zip(ids, visible))):
            layer = source_rgba(source, mask)
            rebuilt = Image.alpha_composite(rebuilt, layer)
            bounds = mask.getbbox()
            if bounds:
                layer.crop(bounds).save(directory / f"{mode}-{identifier}-owned.png")
        rebuilt.save(directory / f"{mode}-reassembled.png")
        without_button = source_rgba(source, residual)
        for identifier, mask in reversed(list(zip(ids, visible))):
            if identifier != "login-button":
                without_button = Image.alpha_composite(without_button, source_rgba(source, mask))
        preview = checker(source.size)
        preview.alpha_composite(without_button)
        preview.save(directory / f"{mode}-button-hidden.png")
        validation[f"{mode}ReassemblyDifferentPixels"] = int(np.any(np.asarray(rebuilt) != source_array, axis=2).sum())
    (directory / "pixel-validation.json").write_text(json.dumps(validation, indent=2))
    print(json.dumps({"candidates": len(validation["pixelChecks"]), "allRgbExact": all(item["rgbExact"] for item in validation["pixelChecks"]),
                      "localReassemblyDifferentPixels": validation["localReassemblyDifferentPixels"],
                      "fullReassemblyDifferentPixels": validation["fullReassemblyDifferentPixels"]}))


if __name__ == "__main__":
    main()
