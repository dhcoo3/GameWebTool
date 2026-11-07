"""Recorded operator correction: replace the compass subregion with its local mask.

No RGB is synthesized. This is an explicitly calibrated correction example,
not a claim that a VLM automatically found these part bounds.
"""
import base64
import io
import json
from pathlib import Path
import numpy as np
from PIL import Image
from pixels import place_mask, source_rgba
from render_pilot import checker

p = Path("output/ui-segmentation-pilot")
report = json.loads((p / "pilot-results.json").read_text())
source = Image.open(report["source"]).convert("RGBA")
whole = next(a for r in report["runs"] if r["regionMode"] == "full" for a in r["assets"] if a["id"] == "title-ornament")["candidates"][0]
original = place_mask(Image.open(p / whole["file"]), whole["maskBounds"], source.size)
parts = json.loads((p / "refinement-local.json").read_text())
compass = next(a for a in parts["assets"] if a["id"] == "compass")
candidate = compass["candidates"][0]
part = place_mask(Image.open(io.BytesIO(base64.b64decode(candidate["maskBase64"]))), candidate["maskBounds"], source.size)
b = compass["promptBounds"]
window = (b["x"], b["y"], b["x"] + b["width"], b["y"] + b["height"])
corrected = original.copy()
corrected.paste(part.crop(window), window[:2])
corrected.save(p / "title-corrected.mask.png")
bounds = corrected.getbbox()
rgba = source_rgba(source, corrected).crop(bounds)
rgba.save(p / "title-corrected.png")
preview = checker(rgba.size)
preview.alpha_composite(rgba)
preview.save(p / "title-corrected-review.png")
(p / "manual-correction.json").write_text(json.dumps({"method": "operator-calibrated-subcomponent-mask-replacement", "bounds": b,
    "originalCandidate": whole["file"], "partCandidate": candidate["candidate"], "partContext": "local",
    "changedMaskPixels": int(np.count_nonzero(np.asarray(corrected) != np.asarray(original))), "rgbGeneration": False,
    "userApproved": False, "note": "Example correction, not automatic semantic detection or production approval."}, indent=2))
