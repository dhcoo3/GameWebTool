import { assertKlingPromptLength, klingMapPrompts, KLING_PROMPT_LIMIT } from './klingPrompt.js';
export function composeTilePrompt(prompt, negativePrompt, referenceKind = '', hasReference = true) {
  const positive = String(prompt || '').trim();
  const negative = String(negativePrompt || '').trim();
  const lowerLayerReference = ['lower-layers', 'lower-layers-marked'].includes(referenceKind);
  const referenceGuidance = hasReference && lowerLayerReference
    ? referenceKind === 'lower-layers-marked'
      ? 'The reference image shows the exact generated lower-layer ground. A semi-transparent magenta overlay with thin white cell borders marks the exact target cells selected for this upper-layer region. Fit the requested content to the marked shape and placement, matching the surrounding ground material, palette, lighting, perspective, texture scale, and art style. The magenta fill and white borders are temporary annotations; do not reproduce them in the result. Preserve the underlying terrain and keep the requested content inside the marked cells.'
      : 'The reference image is a crop of the already generated visible lower scene layers. Match its terrain material, palette, lighting, perspective, texture scale, and art style. Add only the requested upper-layer content so it naturally belongs on this exact ground; do not redesign or replace the underlying terrain. Keep the requested result within the selected region.'
    : '';
  return [positive, referenceGuidance, negative ? `Avoid these elements and qualities: ${negative}` : ''].filter(Boolean).join('\n\n');
}

export function providerPrompts(settings, request) {
  const reference = Boolean(request.imageBase64);
  const source = request.provider === 'kling' ? klingMapPrompts(request) || request : request;
  const separate = request.provider === 'kling' ? !reference : request.provider === 'qwen' && String(settings.qwenImageModel || '').includes('3.0');
  const prompt = [request.provider === 'kling' && request.operation === 'objects' && 'Edit <<<image_1>>> only. Return one full-frame transparent PNG object layer, keeping the exact original layout.', composeTilePrompt(source.prompt, separate ? '' : source.negativePrompt, request.referenceKind, reference)].filter(Boolean).join('\n\n');
  return { prompt, negativePrompt: separate ? String(source.negativePrompt || '').trim() : '', negativeHandling: separate ? 'separate' : 'inline' };
}
export function mapDiagnostics(settings, request, model) {
  const prompts = providerPrompts(settings, request);
  let validationError = '';
  if (request.provider === 'kling') { try { assertKlingPromptLength(prompts.prompt); assertKlingPromptLength(prompts.negativePrompt, '反向提示词'); } catch (e) { validationError = e.message; } }
  const scale = request.scaleReference;
  return { ...prompts, provider: request.provider, model, operation: request.operation, width: request.width, height: request.height, resolution: request.resolution, expansionPolicy: request.expansionPolicy,
    hasImage: Boolean(request.imageBase64), hasSeparateGuide: Boolean(request.guideImageBase64), hasContextImage:Boolean(request.contextImageBase64), hasMask: Boolean(request.maskBase64), referenceMode: request.operation === 'seed' && (request.imageBase64 || request.reference?.positive || request.reference?.negative) ? request.reference?.mode || 'style' : 'none',
    referenceInput: request.operation === 'seed' ? request.reference?.input || 'image' : 'map',
    scale: scale ? { enabled: true, widthPx: scale.widthPx, heightPx: scale.heightPx, objectCount: scale.environmentRulesEnabled ? scale.objectSizes?.entries.length || 0 : 0, frame: scale.frame } : { enabled: false },
    positiveChars: prompts.prompt.length, negativeChars: prompts.negativePrompt.length, limit: request.provider === 'kling' ? KLING_PROMPT_LIMIT : null, validationError };
}
