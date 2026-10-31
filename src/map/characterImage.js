export async function characterImageBounds(blob) {
  if (blob.type !== 'image/png') throw new Error('请选择透明背景 PNG 角色图片。');
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096) throw new Error('角色图片最长边不能超过 4096 px。');
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1, transparent = false;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const alpha = pixels[(y * canvas.width + x) * 4 + 3];
      if (alpha < 255) transparent = true;
      if (alpha <= 8) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    if (right < left) throw new Error('角色图片完全透明，没有可见人物。');
    if (!transparent) throw new Error('角色图片没有透明背景，请先去底后上传 PNG。');
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1, sourceWidth: canvas.width, sourceHeight: canvas.height };
  } finally { bitmap.close(); }
}
