export function validateUiSegmentationRequest(body) {
  if (typeof body?.imageBase64 !== 'string' || !body.imageBase64 || body.imageBase64.length > 34 * 1024 * 1024) throw Object.assign(new Error('缺少有效的原图。'), { status: 400 });
  if (!Array.isArray(body.assets) || !body.assets.length || body.assets.length > 120) throw Object.assign(new Error('每次分割需要 1 至 120 个候选区域。'), { status: 400 });
  const ids = new Set();
  for (const asset of body.assets) {
    if (typeof asset.id !== 'string' || !asset.id || ids.has(asset.id)) throw Object.assign(new Error('候选 ID 缺失或重复。'), { status: 400 });
    ids.add(asset.id);
    const b = asset.bounds;
    if (!b || !['x', 'y', 'width', 'height'].every((k) => Number.isInteger(b[k])) || b.x < 0 || b.y < 0 || b.width < 1 || b.height < 1 || b.x + b.width > 8192 || b.y + b.height > 8192) throw Object.assign(new Error('候选范围必须是原图整数像素坐标。'), { status: 400 });
  }
  if (body.regionMode && !['full', 'local'].includes(body.regionMode)) throw Object.assign(new Error('无效的分割上下文。'), { status: 400 });
  return { imageBase64: body.imageBase64, assets: body.assets.map(({ id, bounds }) => ({ id, bounds })), regionMode: body.regionMode || 'full' };
}

export function validateUiRestoreRequest(body) {
  if (body?.provider !== 'gemini') throw Object.assign(new Error('首版补齐仅支持已配置的 Gemini 图像服务。'), { status: 400 });
  if (body.maskConfirmed !== true) throw Object.assign(new Error('请先预览并确认补齐范围。'), { status: 400 });
  for (const key of ['imageBase64', 'maskBase64']) if (typeof body[key] !== 'string' || !body[key] || body[key].length > 34 * 1024 * 1024) throw Object.assign(new Error('补齐需要原图和有效蒙版。'), { status: 400 });
  for (const key of ['width', 'height']) if (!Number.isInteger(body[key]) || body[key] < 1 || body[key] > 8192) throw Object.assign(new Error('补齐尺寸无效。'), { status: 400 });
  return body;
}
