import { zlibSync } from 'fflate';
import { getUiAsset } from './storage.js';
import { applySourceMask, brushMask, cropPixels, maskBounds, paintOrder, partitionMasks, validateHierarchy } from './layers.js';

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function chunk(type, data) {
  const output = new Uint8Array(data.length + 12), view = new DataView(output.buffer);
  view.setUint32(0, data.length); output.set(new TextEncoder().encode(type), 4); output.set(data, 8);
  let crc = 0xffffffff; for (let i = 4; i < output.length - 4; i++) crc = crcTable[(crc ^ output[i]) & 255] ^ (crc >>> 8);
  view.setUint32(output.length - 4, (crc ^ 0xffffffff) >>> 0); return output;
}

// Encode unpremultiplied RGBA directly; canvas.toBlob can round RGB at alpha edges.
export function rgbaPng(data, width, height) {
  if (data.length !== width * height * 4) throw new Error('PNG 像素尺寸不匹配。');
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header.set([8, 6, 0, 0, 0], 8);
  const scanlines = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) scanlines.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(scanlines)), chunk('IEND', new Uint8Array())], { type: 'image/png' });
}

export function maskRgba(mask, tint = false) {
  const data = new Uint8ClampedArray(mask.length * 4);
  mask.forEach((v, i) => { data.set(tint ? [255, 160, 25, v ? 125 : 0] : [v, v, v, 255], i * 4); });
  return data;
}

export async function decodePixels(blob, expected = null, allowResize = false) {
  const bitmap = await createImageBitmap(blob);
  const width = expected?.width || bitmap.width, height = expected?.height || bitmap.height;
  if (!allowResize && (bitmap.width !== width || bitmap.height !== height)) { bitmap.close(); throw new Error('图片尺寸不匹配，禁止静默拉伸。'); }
  if (allowResize && Math.abs(bitmap.width / bitmap.height - width / height) > .02) { bitmap.close(); throw new Error('补齐结果长宽比不符，不能按原坐标合成。'); }
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(bitmap, 0, 0, width, height); bitmap.close();
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

async function assetMask(project, asset) {
  const { width, height } = project, mask = new Uint8Array(width * height);
  if (asset.maskAssetId && asset.extractionMode === 'mask') {
    const b = asset.maskBounds, image = await decodePixels(await getUiAsset(asset.maskAssetId), b);
    if (b.x < 0 || b.y < 0 || b.x + b.width > width || b.y + b.height > height) throw new Error('蒙版原点超出原图。');
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) mask[(b.y + y) * width + b.x + x] = image.data[(y * b.width + x) * 4] >= 128 ? 255 : 0;
  } else if (asset.extractionMode === 'mask' && asset.polygon?.length >= 3) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.beginPath();
    asset.polygon.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fill();
    const alpha = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < mask.length; i++) mask[i] = alpha[i * 4 + 3] >= 128 ? 255 : 0;
  } else if (asset.extractionMode === 'rect') {
    const b = asset.bounds;
    for (let y = b.y; y < b.y + b.height; y++) mask.fill(255, y * width + b.x, y * width + b.x + b.width);
  }
  return brushMask(mask, width, height, asset.maskStrokes);
}

export async function renderLayers(project, sourceBlob) {
  validateHierarchy(project.assets);
  const source = await decodePixels(sourceBlob, project), count = project.width * project.height;
  const ordered = paintOrder(project.assets.filter((a) => a.enabled !== false)).reverse();
  const masks = await Promise.all(ordered.map((asset) => assetMask(project, asset)));
  const partition = masks.length ? partitionMasks(masks, count) : { visible: [], hidden: [], background: new Uint8Array(count).fill(255), backgroundHidden: new Uint8Array(count) };
  const layers = ordered.map((asset, i) => ({ asset, mask: masks[i], visibleMask: partition.visible[i], hiddenMask: partition.hidden[i] }));
  layers.push({ asset: { id: '__background__', name: '背景', category: 'background', zIndex: -1, parentId: '' }, mask: new Uint8Array(count).fill(255), visibleMask: partition.background, hiddenMask: partition.backgroundHidden });
  for (const layer of layers) {
    const restoration = project.restorations?.[layer.asset.id];
    let generated = null, generatedMask = null;
    if (restoration?.accepted) {
      generated = (await decodePixels(await getUiAsset(restoration.normalizedAssetId), project)).data;
      const savedMask = (await decodePixels(await getUiAsset(restoration.maskAssetId), project)).data;
      generatedMask = Uint8Array.from(layer.hiddenMask, (value, i) => value && savedMask[i * 4] >= 128 ? 255 : 0);
    }
    layer.generatedMask = generatedMask;
    layer.pixels = applySourceMask(source.data, layer.visibleMask, generated, generatedMask);
    const effectiveMask = Uint8Array.from(layer.visibleMask, (value, i) => value || generatedMask?.[i] ? 255 : 0);
    layer.bounds = maskBounds(effectiveMask, project.width, project.height);
  }
  return { source, layers: layers.reverse() };
}

export function reassembleLayers(rendered, hiddenIds = [], onlyId = '') {
  const output = new Uint8ClampedArray(rendered.source.data.length);
  for (const layer of rendered.layers) {
    if (hiddenIds.includes(layer.asset.id) || (onlyId && layer.asset.id !== onlyId)) continue;
    for (let i = 0; i < output.length; i += 4) {
      const alpha = layer.pixels[i + 3] / 255;
      if (!alpha) continue;
      if (alpha === 1) output.set(layer.pixels.subarray(i, i + 4), i);
      else {
        const oldAlpha = output[i + 3] / 255, newAlpha = alpha + oldAlpha * (1 - alpha);
        for (let c = 0; c < 3; c++) output[i + c] = Math.round((layer.pixels[i + c] * alpha + output[i + c] * oldAlpha * (1 - alpha)) / newAlpha);
        output[i + 3] = Math.round(newAlpha * 255);
      }
    }
  }
  return output;
}

export const layerCropBlob = (layer, sourceWidth) => layer.bounds ? rgbaPng(cropPixels(layer.pixels, sourceWidth, layer.bounds), layer.bounds.width, layer.bounds.height) : null;
