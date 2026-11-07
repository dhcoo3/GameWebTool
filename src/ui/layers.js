// Logical hierarchy and draw order are deliberately independent.
export function paintOrder(assets) {
  return [...assets].sort((a, b) => Number(a.zIndex ?? a.order ?? 0) - Number(b.zIndex ?? b.order ?? 0));
}

export function validateHierarchy(assets) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  if (byId.size !== assets.length) throw new Error('图层 ID 重复。');
  for (const asset of assets) {
    const seen = new Set([asset.id]);
    let parent = asset.parentId;
    while (parent) {
      if (!byId.has(parent)) throw new Error(`找不到父图层：${asset.name}`);
      if (seen.has(parent)) throw new Error('父子关系不能形成循环。');
      seen.add(parent); parent = byId.get(parent).parentId;
    }
  }
}

export function layerTree(assets) {
  validateHierarchy(assets);
  const result = [], ordered = paintOrder(assets);
  const visit = (parentId, depth) => ordered.filter((a) => (a.parentId || '') === parentId).forEach((asset) => {
    result.push({ ...asset, depth }); visit(asset.id, depth + 1);
  });
  visit('', 0); return result;
}

export function partitionMasks(masks, pixelCount) {
  const covered = new Uint8Array(pixelCount), visible = [], hidden = [];
  for (const mask of masks) {
    if (mask.length !== pixelCount) throw new Error('蒙版尺寸与原图不一致。');
    const own = new Uint8Array(pixelCount), underneath = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      if (mask[i]) { own[i] = covered[i] ? 0 : 255; underneath[i] = covered[i] ? 255 : 0; covered[i] = 255; }
    }
    visible.push(own); hidden.push(underneath);
  }
  return { visible, hidden, background: covered.map((value) => value ? 0 : 255), backgroundHidden: covered };
}

export function applySourceMask(source, mask, generated = null, generatedMask = null) {
  if (source.length !== mask.length * 4 || (generated && generated.length !== source.length)) throw new Error('图像或蒙版尺寸不匹配。');
  const output = new Uint8ClampedArray(source);
  for (let i = 0; i < mask.length; i++) {
    if (generated && generatedMask?.[i]) output.set(generated.subarray(i * 4, i * 4 + 4), i * 4);
    else output[i * 4 + 3] = Math.round(source[i * 4 + 3] * mask[i] / 255);
  }
  return output;
}

export function maskBounds(mask, width, height) {
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
  }
  return right > left ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

export function cropPixels(data, sourceWidth, bounds) {
  const cropped = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) {
    const start = ((bounds.y + y) * sourceWidth + bounds.x) * 4;
    cropped.set(data.subarray(start, start + bounds.width * 4), y * bounds.width * 4);
  }
  return cropped;
}

export function brushMask(mask, width, height, strokes) {
  for (const stroke of strokes || []) {
    const radius = Math.max(1, Math.min(128, Number(stroke.radius) || 1));
    const stamp = (cx, cy) => {
      for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(height, Math.ceil(cy + radius)); y++)
        for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(width, Math.ceil(cx + radius)); x++)
          if ((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= radius ** 2) mask[y * width + x] = stroke.mode === 'erase' ? 0 : 255;
    };
    const points = (stroke.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    points.forEach((point, i) => {
      const previous = points[i - 1] || point, count = Math.max(1, Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / Math.max(1, radius / 2)));
      for (let step = 0; step <= count; step++) stamp(previous.x + (point.x - previous.x) * step / count, previous.y + (point.y - previous.y) * step / count);
    });
  }
  return mask;
}
