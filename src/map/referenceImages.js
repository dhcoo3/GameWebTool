import { canvas, assetImage } from './images.js';
import { effectiveReference, normalizeReferenceSettings } from './reference.js';

export async function referenceSample(project, assets) {
  if (!project.styleAssetId) return null;
  const image = await assetImage(project.styleAssetId, assets), settings = normalizeReferenceSettings(project.referenceSettings);
  const crop = settings.mode === 'style' ? settings.crop : null;
  const x = crop ? Math.floor(crop.x * image.width) : 0, y = crop ? Math.floor(crop.y * image.height) : 0;
  const width = crop ? Math.max(1, Math.min(image.width - x, Math.round(crop.width * image.width))) : image.width;
  const height = crop ? Math.max(1, Math.min(image.height - y, Math.round(crop.height * image.height))) : image.height;
  const result = canvas(width, height); result.getContext('2d').drawImage(image, x, y, width, height, 0, 0, width, height); return result;
}
export async function seedReference(project, assets) {
  if (!effectiveReference(project).hasImage) return undefined;
  const image = await referenceSample(project, assets), result = canvas(project.tileWidth, project.tileHeight);
  const scale = Math.min(result.width / image.width, result.height / image.height);
  result.getContext('2d').drawImage(image, (result.width - image.width * scale) / 2, (result.height - image.height * scale) / 2, image.width * scale, image.height * scale);
  return result;
}
