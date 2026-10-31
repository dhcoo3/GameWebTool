import { assetImage, canvas, requestImage, storeCanvas } from './images.js';
import { matteValid } from './chromaKey.js';

export function layerAlphaValid(image, kind) {
  const pixels = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
  let clear = false, visible = false, opaque = true;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 8) clear = true;
    if (pixels[i] >= 8) visible = true;
    if (pixels[i] !== 255) opaque = false;
  }
  return kind === 'objects' ? clear && visible : opaque;
}
export async function rebuildLayer(project, assets, tile, kind, signal) {
  if (!['objects', 'ground'].includes(kind)) throw new Error('分层类型无效。');
  const original = canvas(tile.width, tile.height); original.getContext('2d').drawImage(await assetImage(tile.originalId, assets), 0, 0, original.width, original.height);
  const result = await requestImage(project, assets, kind, { image: original, signal, preserveRaw: kind === 'ground' });
  const alphaValid = layerAlphaValid(result.canvas, kind);
  const valid = alphaValid && !(project.provider === 'gemini' && kind === 'objects' && result.chromaKeyRemoved !== true);
  return { assetId: await storeCanvas(result.canvas, assets), valid, width: result.actualWidth, height: result.actualHeight,
    rawAssetId: result.rawAssetId, rawMimeType: result.rawMimeType, generation: result.generation, matteSourceAssetId: result.matteSourceAssetId, matteStats: result.matteStats };
}
export async function importLayerImage(file, assets, tile, kind) {
  if (file?.type !== 'image/png') throw new Error('请导入 PNG 图片；物件层需要真实透明背景。');
  if (file.size > 64 * 1024 * 1024) throw new Error('单张图层不能超过 64 MB。');
  const image = await createImageBitmap(file);
  try {
    if (image.width > 8192 || image.height > 8192 || image.width * image.height > 32_000_000) throw new Error('图层图片过大，请使用不超过 8192 px、3200 万像素的图片。');
    const ratioError = Math.abs(image.width / image.height / (tile.width / tile.height) - 1);
    if (ratioError > .01) throw new Error('图层与原图的宽高比例不一致，请提供保留完整画幅的图层；工具不会自动裁切或拉伸不同画幅。');
    const fitted = canvas(tile.width, tile.height); fitted.getContext('2d').drawImage(image, 0, 0, fitted.width, fitted.height);
    return { assetId: await storeCanvas(fitted, assets), valid: layerAlphaValid(fitted, kind), width: image.width, height: image.height };
  } finally { image.close(); }
}
export const needsMatteCheck = (draft) => draft?.objectsGeneration?.model?.startsWith('gemini') || Boolean(draft?.objectsMatteStats);
export const validLayerPair = (draft) => Boolean(draft?.objectsId && (draft.layerMode === 'mask' || draft?.groundId) &&
  (draft.layerMode !== 'direct' || (draft.objectsValid === true && draft.groundValid === true && (!needsMatteCheck(draft) || matteValid(draft.objectsMatteStats)))));
