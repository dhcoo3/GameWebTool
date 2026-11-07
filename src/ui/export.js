import { strToU8, zipSync } from 'fflate';
import { buildUiManifest, clampBounds } from './manifest.js';
import { buildLayeredUiExport } from './exportLayered.js';

const canvasBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 导出失败。')), 'image/png'));
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

function createCanvas(width, height) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}

function drawMask(maskContext, asset) {
  const { bounds, polygon, maskStrokes = [] } = asset;
  maskContext.fillStyle = '#fff';
  if (Array.isArray(polygon) && polygon.length >= 3) {
    maskContext.beginPath();
    polygon.forEach((point, index) => index ? maskContext.lineTo(point.x - bounds.x, point.y - bounds.y) : maskContext.moveTo(point.x - bounds.x, point.y - bounds.y));
    maskContext.closePath(); maskContext.fill();
  } else maskContext.fillRect(0, 0, bounds.width, bounds.height);
  for (const stroke of maskStrokes) {
    if (!Array.isArray(stroke.points) || !stroke.points.length) continue;
    maskContext.save(); maskContext.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
    maskContext.strokeStyle = '#fff'; maskContext.fillStyle = '#fff'; maskContext.lineWidth = Math.max(1, Number(stroke.radius) * 2); maskContext.lineCap = 'round'; maskContext.lineJoin = 'round';
    const points = stroke.points.map((point) => ({ x: point.x - bounds.x, y: point.y - bounds.y }));
    if (points.length === 1) { maskContext.beginPath(); maskContext.arc(points[0].x, points[0].y, Math.max(1, Number(stroke.radius)), 0, Math.PI * 2); maskContext.fill(); }
    else { maskContext.beginPath(); maskContext.moveTo(points[0].x, points[0].y); points.slice(1).forEach((point) => maskContext.lineTo(point.x, point.y)); maskContext.stroke(); }
    maskContext.restore();
  }
}

async function renderAsset(sourceBitmap, asset) {
  const bounds = clampBounds(asset.bounds, sourceBitmap.width, sourceBitmap.height);
  const { x, y, width, height } = bounds;
  const output = createCanvas(width, height), context = output.getContext('2d');
  context.drawImage(sourceBitmap, x, y, width, height, 0, 0, width, height);
  let maskBlob = null;
  if (asset.extractionMode === 'mask') {
    const mask = createCanvas(width, height), maskContext = mask.getContext('2d');
    drawMask(maskContext, { ...asset, bounds });
    const opaqueMask = createCanvas(width, height), opaqueMaskContext = opaqueMask.getContext('2d');
    opaqueMaskContext.fillStyle = '#000'; opaqueMaskContext.fillRect(0, 0, width, height);
    opaqueMaskContext.drawImage(mask, 0, 0);
    maskBlob = await canvasBlob(opaqueMask);
    context.globalCompositeOperation = 'destination-in'; context.drawImage(mask, 0, 0); context.globalCompositeOperation = 'source-over';
  }
  return { cropBlob: await canvasBlob(output), maskBlob };
}

async function makeAnnotatedPreview(sourceBitmap, project) {
  const canvas = createCanvas(project.width, project.height), context = canvas.getContext('2d');
  context.drawImage(sourceBitmap, 0, 0, project.width, project.height);
  const scale = Math.max(1, Math.max(project.width, project.height) / 1400);
  context.font = `600 ${Math.round(18 * scale)}px sans-serif`; context.lineWidth = 2 * scale;
  (project.assets || []).forEach((asset, index) => {
    if (asset.enabled === false) return;
    const { x, y, width, height } = asset.bounds;
    context.strokeStyle = '#00eaff'; context.strokeRect(x, y, width, height);
    if (Array.isArray(asset.polygon) && asset.polygon.length >= 3) {
      context.beginPath();
      asset.polygon.forEach((point, pointIndex) => pointIndex ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.closePath(); context.fillStyle = '#ffc45f24'; context.fill(); context.strokeStyle = '#ffc45f'; context.stroke();
    }
    const label = `${index + 1} ${asset.name || 'UI 元素'}`;
    const fontSize = Math.round(18 * scale), labelWidth = context.measureText(label).width + 12 * scale, labelHeight = 26 * scale;
    context.fillStyle = '#071a21e8'; context.fillRect(x, Math.max(0, y - labelHeight), labelWidth, labelHeight);
    context.fillStyle = '#fff'; context.fillText(label, x + 6 * scale, Math.max(fontSize, y - 7 * scale));
  });
  return canvasBlob(canvas);
}

export async function buildUiExport(project, sourceBlob, { unity = false, importerCode = '' } = {}) {
  if (project?.pipelineVersion === 2) return buildLayeredUiExport(project, sourceBlob, { unity, importerCode });
  if (!project?.approved) throw new Error('请先校对并确认 UI 拆分方案。');
  if (!project.assets?.some((asset) => asset.enabled !== false)) throw new Error('请至少保留一个要导出的 UI 元素。');
  const sourceBitmap = await createImageBitmap(sourceBlob);
  if (sourceBitmap.width !== project.width || sourceBitmap.height !== project.height) { sourceBitmap.close(); throw new Error('源图尺寸已变化，请重新导入并分析。'); }
  try {
    const root = unity ? 'Assets/ProductionFactoryUI/' : 'UIAssets/';
    const files = {};
    const sourceExt = sourceBlob.type === 'image/jpeg' ? 'jpg' : sourceBlob.type === 'image/webp' ? 'webp' : 'png';
    const sourceFile = `source.${sourceExt}`;
    files[`${root}${sourceFile}`] = await bytes(sourceBlob);
    files[`${root}preview.png`] = await bytes(await makeAnnotatedPreview(sourceBitmap, project));
    const manifestAssets = project.assets.filter((asset) => asset.enabled !== false).map((asset, index) => {
      const file = `asset_${String(index + 1).padStart(3, '0')}.png`;
      return { ...asset, bounds: clampBounds(asset.bounds, project.width, project.height), cropFile: `crops/${file}`, maskFile: asset.extractionMode === 'mask' ? `masks/${file}` : '' };
    });
    for (const asset of manifestAssets) {
      const { cropBlob, maskBlob } = await renderAsset(sourceBitmap, asset);
      files[`${root}${asset.cropFile}`] = await bytes(cropBlob);
      if (maskBlob) files[`${root}${asset.maskFile}`] = await bytes(maskBlob);
    }
    const manifest = buildUiManifest(project, manifestAssets); manifest.source.file = sourceFile;
    files[`${root}manifest.json`] = strToU8(JSON.stringify(manifest, null, 2));
    if (unity) {
      if (!importerCode.trim()) throw new Error('Unity 导入脚本不可用，请刷新页面后重试。');
      files[`${root}Editor/FactoryUiImporter.cs`] = strToU8(importerCode);
      files[`${root}README.txt`] = strToU8(`生产工厂 · UGUI UI 资源包\n\n兼容 Unity 2022.3。将 ZIP 解压到 Unity 工程根目录，确认文件位于 Assets/ProductionFactoryUI 下。等待脚本编译，然后使用菜单 Tools > 生产工厂 > 导入 UI 资源，选择 Assets/ProductionFactoryUI/manifest.json。Prefab 将生成在 Assets/GeneratedUI。\n\nCanvas 使用 CanvasScaler / Scale With Screen Size，参考分辨率等于源 UI 图片尺寸。图像和文字按清单顺序导入为 UI 图片图层。透明抠图是估算蒙版结果；扁平源图中被遮挡的部分无法恢复。\n`);
    }
    return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
  } finally { sourceBitmap.close(); }
}

export function downloadUiFile(blob, fileName) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName; document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
