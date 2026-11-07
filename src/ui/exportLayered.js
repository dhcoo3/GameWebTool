import { zipSync, strToU8 } from 'fflate';
import { getUiAsset } from './storage.js';
import { buildUiManifest } from './manifest.js';
import { cropPixels } from './layers.js';
import { layerCropBlob, maskRgba, reassembleLayers, renderLayers, rgbaPng } from './raster.js';

export async function buildLayeredUiExport(project, sourceBlob, { unity = false, importerCode = '' } = {}) {
  const enabled = project.assets.filter((a) => a.enabled !== false);
  if (!project.approved || !enabled.length || enabled.some((a) => !a.reviewed || a.maskStale)) throw new Error('请逐层验边并确认拆分方案。');
  const rendered = await renderLayers(project, sourceBlob), root = unity ? 'Assets/ProductionFactoryUI/' : 'UIAssets/';
  const files = {}, entries = [];
  const add = async (name, blob) => { files[root + name] = new Uint8Array(await blob.arrayBuffer()); };
  await add('source.png', rgbaPng(rendered.source.data, project.width, project.height));
  const originalBlob = project.originalAssetId ? await getUiAsset(project.originalAssetId) : sourceBlob;
  await add(`original.${originalBlob.type === 'image/jpeg' ? 'jpg' : originalBlob.type === 'image/webp' ? 'webp' : 'png'}`, originalBlob);
  await add('reassembled.png', rgbaPng(reassembleLayers(rendered), project.width, project.height));
  for (const [index, layer] of rendered.layers.entries()) {
    if (!layer.bounds) continue;
    const name = `asset_${String(index + 1).padStart(3, '0')}.png`, cropFile = `crops/${name}`, maskFile = `masks/${name}`;
    await add(cropFile, layerCropBlob(layer, project.width));
    const maskPixels = cropPixels(maskRgba(layer.visibleMask), project.width, layer.bounds);
    await add(maskFile, rgbaPng(maskPixels, layer.bounds.width, layer.bounds.height));
    let generatedMaskFile = '';
    if (layer.generatedMask?.some(Boolean)) {
      generatedMaskFile = `generated-masks/${name}`;
      await add(generatedMaskFile, rgbaPng(cropPixels(maskRgba(layer.generatedMask), project.width, layer.bounds), layer.bounds.width, layer.bounds.height));
      const restoration = project.restorations[layer.asset.id];
      const raw = await getUiAsset(restoration.rawAssetId);
      await add(`reconstruction-candidates/${name.replace('.png', raw.type === 'image/jpeg' ? '.jpg' : raw.type === 'image/webp' ? '.webp' : '.png')}`, raw);
    }
    entries.push({ ...layer.asset, bounds: layer.bounds, order: index, zIndex: index, extractionMode: 'mask', cropFile, maskFile, generatedMaskFile });
  }
  const manifest = buildUiManifest(project, entries);
  files[root + 'manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  if (unity) {
    if (!importerCode.trim()) throw new Error('Unity 导入脚本不可用。');
    files[root + 'Editor/FactoryUiImporter.cs'] = strToU8(importerCode);
  }
  files[root + 'README.txt'] = strToU8(`生产工厂 UI 分层素材 v2\n\nUnity 2022.3：解压 Unity ZIP 到工程根目录，菜单 Tools > 生产工厂 > 导入 UI 资源，选择 manifest.json。\n逻辑父子关系记录在 groups，图片按 order 绘制。源图尺寸为参考分辨率。\nsource.png 是解码到 sRGB 的原图参考，不自动作为底层导入；背景是扣除已提取像素后的独立图层。\nreassembled.png 仅由导出图层组成。原像素分区重组一致不证明语义分割正确，还需单层和隐藏图层检查。\nmasks 记录可见原像素，generated-masks 记录经确认的 AI 重建区域，二者坐标以各素材 bounds 为原点。AI 重建并非恢复真实隐藏内容。\n默认硬边蒙版，无自动羽化或 RGB 重绘；半透明边缘与阴影需要单独校对。\n`);
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}
