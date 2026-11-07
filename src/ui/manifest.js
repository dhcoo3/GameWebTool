export const UI_PACKAGE_FORMAT = 'game-asset-factory-ui';

export function clampBounds(bounds, sourceWidth, sourceHeight) {
  const x = Math.max(0, Math.min(sourceWidth - 1, Math.floor(Number(bounds?.x))));
  const y = Math.max(0, Math.min(sourceHeight - 1, Math.floor(Number(bounds?.y))));
  const width = Math.max(1, Math.min(sourceWidth - x, Math.ceil(Number(bounds?.width))));
  const height = Math.max(1, Math.min(sourceHeight - y, Math.ceil(Number(bounds?.height))));
  if (![x, y, width, height].every(Number.isFinite)) throw new Error('UI 元素边界坐标无效。');
  return { x, y, width, height };
}

export function buildUiManifest(project, assets = project.assets || []) {
  if (!Number.isInteger(project.width) || !Number.isInteger(project.height) || project.width < 1 || project.height < 1) throw new Error('请先导入或生成一张有效的 UI 图片。');
  return {
    format: UI_PACKAGE_FORMAT,
    version: project.pipelineVersion === 2 ? 2 : 1,
    ...(project.pipelineVersion === 2 ? { groups: (project.assets || []).map((a) => ({ id: a.id, name: a.name, parentId: a.parentId || '' })), sourceHash: project.sourceHash || '', pixelSpace: 'decoded-srgb', reconstruction: 'generated-regions-explicitly-masked' } : {}),
    name: String(project.name || '未命名 UI').trim() || '未命名 UI',
    coordinateSystem: 'pixel-top-left-y-down',
    referenceResolution: { width: project.width, height: project.height },
    source: { width: project.width, height: project.height, file: 'source.png' },
    assets: assets.filter((asset) => asset.enabled !== false).map((asset, index) => {
      const bounds = clampBounds(asset.bounds, project.width, project.height);
      return {
        id: asset.id,
        ...(project.pipelineVersion === 2 ? { parentId: asset.parentId || '', zIndex: asset.zIndex ?? asset.order, generatedMaskFile: asset.generatedMaskFile || '', provenance: asset.generatedMaskFile ? 'source-and-ai-reconstruction' : 'source-pixels' } : {}),
        name: String(asset.name || `UI 元素 ${index + 1}`).trim() || `UI 元素 ${index + 1}`,
        category: String(asset.category || '其他'),
        order: Number.isFinite(Number(asset.order)) ? Number(asset.order) : index,
        bounds,
        cropFile: asset.cropFile,
        extractionMode: asset.extractionMode === 'mask' ? 'mask' : 'rect',
        maskFile: asset.maskFile || '',
        confidence: Number.isFinite(Number(asset.confidence)) ? Math.max(0, Math.min(1, Number(asset.confidence))) : null,
        notes: String(asset.notes || ''),
      };
    }),
  };
}
