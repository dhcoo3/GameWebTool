export function hasUsableUiContour(asset) {
  return Array.isArray(asset?.polygon) && asset.polygon.length >= 3;
}

export function shouldUseUiContour(asset) {
  if (!hasUsableUiContour(asset)) return false;
  const purpose = `${asset.category || ''} ${asset.name || ''}`.toLowerCase();
  return /(icon|badge|decorative|item|logo|emblem|avatar|ornament|portrait|character|图标|徽章|装饰|道具|标志|头像|立绘|角色)/i.test(purpose);
}

export function recommendedUiExtractionMode(asset) {
  return shouldUseUiContour(asset) ? 'mask' : 'rect';
}
