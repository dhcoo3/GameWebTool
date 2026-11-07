import { referenceInstructions, REFERENCE_MODES } from '../src/map/reference.js';
import { mapGenerationPrompts, mapUserPrompts, mapGlobalPrompts } from '../src/map/prompts.js';
import { validateScaleContext } from '../src/map/scale.js';
import { layerGenerationPrompts, LAYER_OPERATIONS } from '../src/map/layerPrompts.js';
import { supportsObjectLayers } from '../src/map/layerCapabilities.js';
import { DEFAULT_GEMINI_MODEL, GEMINI_GROUND_RESOLUTIONS, geminiResolutions, resolveGeminiGround } from '../src/map/geminiResolution.js';
import { gptImageResolutions, gptImageSize } from '../src/map/gptImageSize.js';
import { SIMPLE_EXPANSION } from '../src/map/simpleExpansion.js';

export const MAP_CAPABILITIES = {
  openai: { mask: true, transparentObjects: true, resolutions: ['native'] },
  apiyi: { mask: true, transparentObjects: true, resolutions: ['native'] },
  gemini: { mask: false, transparentObjects: true, resolutions: geminiResolutions(DEFAULT_GEMINI_MODEL) },
  qwen: { mask: false, resolutions: ['native', '1K', '2K'] },
  kling: { mask: false, transparentObjects: true, resolutions: ['native', '1K', '2K'] },
};
const INSTRUCTIONS = {
  objects: 'Extract a full-canvas transparent foreground object layer from the original image, preserving its coordinates.',
  seed: 'Create one complete seamless game map region. Fill the entire image with coherent scenery. Follow the assigned reference role when present. Keep a consistent orthographic viewing angle and world scale within the new scene. No frame, captions or interface.',
  expand: 'This is spatially aligned map outpainting. Treat every protected-to-editable boundary as an invisible crop through one continuous image, never as a visible cut. Match the neighboring edge pixels and continue tree trunks and branches, roads, paths, wall courses, roof edges, fences, shorelines, paving, grass and shadows across all edges with matching direction, width, spacing, scale, material, palette, lighting and detail density. Do not create a straight horizontal or vertical seam, color or brightness band, abrupt texture transition, blurred/smudged transition, border, horizon, repeated landmark or duplicated structure. Fill ONLY the editable area; preserve all protected pixels, positions, scale, camera and framing exactly.',
  matte: 'Return ONLY a precisely aligned binary segmentation mask of the input map: solid white for all raised objects (buildings, trees, props, vehicles, walls), solid black for walkable ground, roads and water. Preserve the exact shapes and locations of the ORIGINAL objects. Do not redraw, relocate or add objects. No colors, texture, shadows, labels or interface. Output a full-frame black-and-white mask at the same aspect ratio as the reference.',
  ground: 'Repair the ground underneath the masked raised objects. Remove buildings, trees, props and vehicles inside the editable area, then reconstruct the terrain, roads and ground textures behind them, matching all surrounding material, perspective, scale and lighting. Keep the unmasked ground unchanged. Do not add new raised objects. Keep exactly the input framing.',
  retouch: 'Edit ONLY the marked/masked region of this game map following the user request. Keep all other pixels, framing, object positions, perspective, scale and art style unchanged. Blend naturally at the region boundary.',
};
export function validateMapRequest(body, settings = {}) {
  if (body.operation === 'expand' && body.expansionPolicy === SIMPLE_EXPANSION) throw Object.assign(new Error('简化扩图流程已停用，请刷新页面并重新创建任务。'), { status: 400 });
  if (body.operation === 'seed') {
    const reference = body.reference || {};
    if (reference.mode && !Object.hasOwn(REFERENCE_MODES, reference.mode) || reference.input && !['image', 'text'].includes(reference.input)) throw Object.assign(new Error('参考用途或风格输入方式无效。'), { status: 400 });
    const mode = reference.mode || 'style', input = mode === 'style' && reference.input === 'text' ? 'text' : 'image';
    body = { ...body, reference: { mode, input, positive: typeof reference.positive === 'string' ? reference.positive : '', negative: typeof reference.negative === 'string' ? reference.negative : '' }, ...(input === 'text' ? { imageBase64: '', maskBase64: '' } : {}) };
  }
  if (!MAP_CAPABILITIES[body.provider]) throw Object.assign(new Error('请选择有效的图像服务。'), { status: 400 });
  if (!INSTRUCTIONS[body.operation]) throw Object.assign(new Error('地图生成操作无效。'), { status: 400 });
  if (body.operation === 'objects' && !supportsObjectLayers(body.provider)) throw Object.assign(new Error('当前图像服务不支持物件层生成；可切换 Gemini、可灵、OpenAI 或 API易，也可导入透明 PNG。'), { status: 400 });
  const width = Number(body.width), height = Number(body.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw Object.assign(new Error('地图生成尺寸无效。'), { status: 400 });
  if (body.operation !== 'seed' && !body.imageBase64) throw Object.assign(new Error('此操作需要参考图片。'), { status: 400 });
  if (!String(body.prompt || '').trim() && body.operation === 'seed') throw Object.assign(new Error('请填写地图描述。'), { status: 400 });
  const resolution = body.resolution || 'native';
  const geminiGround = body.provider === 'gemini' && body.operation === 'ground';
  const resolutions = geminiGround ? ['native', ...GEMINI_GROUND_RESOLUTIONS] : body.provider === 'gemini' ? geminiResolutions(settings.geminiModel || DEFAULT_GEMINI_MODEL) : body.provider === 'apiyi' ? gptImageResolutions(settings.apiyiImageModel || '') : MAP_CAPABILITIES[body.provider].resolutions;
  if (!resolutions.includes(resolution)) throw Object.assign(new Error('当前服务不支持所选输出分辨率，请使用服务原生尺寸。'), { status: 400 });
  body = { ...body, outputSize: undefined };
  if (body.provider === 'apiyi' && resolution !== 'native') {
    const outputWidth = Number(body.outputWidth ?? width), outputHeight = Number(body.outputHeight ?? height);
    if (!Number.isFinite(outputWidth) || !Number.isFinite(outputHeight) || outputWidth < 1 || outputHeight < 1 || outputWidth > 8192 || outputHeight > 8192) throw Object.assign(new Error('目标输出画幅无效。'), { status: 400 });
    try { body = { ...body, outputSize: gptImageSize(outputWidth, outputHeight, resolution) }; }
    catch (error) { throw Object.assign(error, { status: 400 }); }
  }
  if (geminiGround) resolveGeminiGround(settings.geminiModel || DEFAULT_GEMINI_MODEL, resolution, width, height);
  if (body.guideImageBase64 && body.provider === 'qwen' && !/^qwen-image-(3\.0|edit-(plus|max))/.test(settings.qwenImageModel || '')) body = { ...body, imageBase64: body.guideImageBase64, guideImageBase64: '', contextImageBase64:'', separateGuide: false };
  const guide = body.separateGuide && body.guideImageBase64 ? 'Image 1 is the CLEAN spatial reference. Image 2 is the SAME frame with a temporary MAGENTA edit guide. Return ONE image aligned exactly with image 1; modify only the marked area. Continue every trunk, branch, road and contour crossing its boundary. Never reproduce the guide or create a collage.' : body.markedGuide ? 'The semi-transparent MAGENTA region is a temporary editing guide: replace it with the requested content, and remove ALL magenta guide coloring from the final image. Preserve the visible unmarked neighboring content. Blank padding outside the image content is not part of the scene.' : 'When an editing mask is supplied, opaque pixels are protected and transparent pixels are editable.';
  const scaleReference = ['seed', 'expand', 'retouch'].includes(body.operation) ? validateScaleContext(body.scaleReference) : undefined;
  const layerOperation = LAYER_OPERATIONS.includes(body.operation);
  const prompts = layerOperation ? layerGenerationPrompts(body.operation, width, height, typeof body.layerPrompt === 'string' ? body.layerPrompt.slice(0, 8000) : '') : mapGlobalPrompts(body.operation, mapGenerationPrompts(body.operation, body.prompt, body.negativePrompt, scaleReference), body);
  const reference = body.operation === 'seed' ? referenceInstructions(body.reference || {}, Boolean(body.imageBase64), Boolean(scaleReference)) : { prompt: '', negativePrompt: '' };
  const local = mapGlobalPrompts(body.operation, mapUserPrompts(body.operation, body.prompt, body.negativePrompt), body);
  prompts.prompt = [prompts.prompt, reference.prompt].filter(Boolean).join('\n\n');
  prompts.negativePrompt = [prompts.negativePrompt, reference.negativePrompt].filter(Boolean).join(', ');
  local.prompt = [local.prompt, reference.prompt].filter(Boolean).join('\n\n');
  local.negativePrompt = [local.negativePrompt, reference.negativePrompt].filter(Boolean).join(', ');
  if (body.provider === 'gemini' && body.operation === 'objects') prompts.prompt += '\n\nGemini returns JPEG and cannot encode alpha. Render the extracted foreground objects over one perfectly uniform, fully saturated pure magenta (#FF00FF) background covering every gap and reaching all four canvas edges. Do not use magenta on any object. No gradient, shadows, ground, or other background colors. This magenta will be removed locally by edge-connected color keying.';
  if (body.operation === 'ground' && body.markedGuide) prompts.prompt += '\nMAGENTA is a temporary editing guide marking the object footprints to replace with clean ground. Remove ALL magenta coloring. Preserve unmarked terrain and the exact full-frame alignment.';
  return { ...body, width, height, resolution, scaleReference, referenceKind: 'map-edit', mapPrompt: { operation: body.operation, ...local },
    prompt: layerOperation ? prompts.prompt : [INSTRUCTIONS[body.operation], body.contextImageBase64 && 'The LAST image is a WIDER CONTEXT reference with a different field of view. Use it ONLY to understand object scale and neighboring structures. Image 1 defines the exact OUTPUT frame and camera scale. Return that target frame, NOT the wider context. Never zoom out, return a whole-scene overview, or fit extra scenery into the target. Image 2, when present, marks the edit area in image 1.', !['seed', 'matte'].includes(body.operation) && guide, body.operation !== 'matte' && `User art direction and requirements: ${prompts.prompt}`].filter(Boolean).join('\n\n'),
    negativePrompt: layerOperation ? '' : prompts.negativePrompt };
}
