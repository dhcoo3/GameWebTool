"""Deterministic source-pixel operations used by the quality pilot."""
import numpy as np
from PIL import Image


def place_mask(mask, bounds, source_size):
    x, y, w, h = (bounds[key] for key in ("x", "y", "width", "height"))
    sw, sh = source_size
    if min(x, y) < 0 or min(w, h) < 1 or x + w > sw or y + h > sh:
        raise ValueError("Mask origin is outside the source")
    if mask.size != (w, h):
        raise ValueError("Mask dimensions mismatch; do not silently resize")
    result = Image.new("L", source_size, 0)
    result.paste(mask.convert("L"), (x, y))
    return result


def source_rgba(source, mask):
    if source.size != mask.size:
        raise ValueError("Source and mask dimensions differ")
    rgba = np.array(source.convert("RGBA"))
    alpha = np.asarray(mask.convert("L"))
    rgba[:, :, 3] = ((rgba[:, :, 3].astype(np.uint16) * alpha + 127) // 255).astype(np.uint8)
    return Image.fromarray(rgba)


def visible_ownership(masks_front_to_back):
    if not masks_front_to_back:
        raise ValueError("At least one mask is required")
    shape = masks_front_to_back[0].size
    covered = np.zeros((shape[1], shape[0]), dtype=bool)
    visible = []
    for mask in masks_front_to_back:
        if mask.size != shape:
            raise ValueError("Layer mask dimensions differ")
        array = np.asarray(mask)
        if not np.isin(array, (0, 255)).all():
            raise ValueError("The pilot ownership check supports hard masks only")
        region = array == 255
        visible.append(Image.fromarray((region & ~covered).astype(np.uint8) * 255))
        covered |= region
    return visible, Image.fromarray((~covered).astype(np.uint8) * 255)


def composite_reconstruction(source, generated, mask):
    if source.size != generated.size or source.size != mask.size:
        raise ValueError("Reconstruction dimensions must explicitly match the source")
    # np.where for hard regions avoids canvas premultiplication/rounding and
    # guarantees source RGBA bytes outside the mask remain untouched.
    region = np.asarray(mask.convert("L"))
    if not np.isin(region, (0, 255)).all():
        raise ValueError("Approve a hard reconstruction region before compositing")
    original = np.array(source.convert("RGBA"))
    generated_rgba = np.asarray(generated.convert("RGBA"))
    original[region == 255] = generated_rgba[region == 255]
    return Image.fromarray(original)
