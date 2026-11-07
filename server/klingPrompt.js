import { scalePrompt } from '../src/map/scale.js';
import { layerGenerationPrompts, LAYER_OPERATIONS } from '../src/map/layerPrompts.js';

export const KLING_PROMPT_LIMIT = 2500;
const operations = {
  seed: 'Create a continuous game map. Follow the assigned reference role. Keep uniform orthographic camera and world scale.',
  expand: 'Outpaint only the editable area at the SAME reference camera zoom and object pixel sizes. Continue trunks, branches, paving, roads, roofs, walls and fences with matching endpoints, widths, materials, lighting and detail density. Treat the edit boundary as an invisible crop through one scene. No smaller objects to fit more content, straight seams, color/brightness bands, blur, smudge or repeated landmarks. Preserve protected pixels, positions and framing exactly; no resizing, rotation or rearrangement.',
  retouch: 'Edit ONLY the marked/masked region. Keep other content, framing, positions, camera, scale and style unchanged. Blend the boundary.',
  ground: 'Remove raised objects ONLY in the editable region; reconstruct ground/roads naturally. Preserve other content and framing. Add no raised objects.',
  matte: 'Return ONLY an aligned binary segmentation mask: WHITE raised objects (buildings, trees, props, walls), BLACK ground/roads/water. Preserve original shapes and positions. No colors, shadows, text or redrawing.',
};
export function klingMapPrompts(request) {
  const source = request.mapPrompt, operation = source?.operation;
  if (request.referenceKind !== 'map-edit' || !operations[operation]) return null;
  if (LAYER_OPERATIONS.includes(operation)) return layerGenerationPrompts(operation, request.width, request.height, request.prompt);
  const frame = ['seed', 'expand'].includes(operation)
    ? `Fill the rectangular ${operation === 'seed' ? 'image' : 'editable area'}, ALL FOUR CORNERS and edges. Isometric/45-degree is the camera angle ONLY; no diamond-shaped map outline, floating slab, diorama, border, backdrop padding or cutaway walls.${operation === 'seed' ? ' Ignore isolated outlines in reference images.' : ''}` : '';
  const guide = !['seed', 'matte'].includes(operation)
    ? request.markedGuide ? 'MAGENTA is a temporary edit guide: replace it with requested content; remove the guide, preserve unmarked content and ignore outer blank padding.' : 'Opaque mask pixels are protected; transparent pixels are editable.' : '';
  const scale = ['seed', 'expand', 'retouch'].includes(operation) ? scalePrompt(request.scaleReference, { compact: true, referenceLocked: operation === 'expand' }) : '';
  return { prompt: [operations[operation], frame, guide, scale, operation !== 'matte' && source.prompt].filter(Boolean).join('\n\n'), negativePrompt: operation === 'matte' ? '' : source.negativePrompt };
}
export function assertKlingPromptLength(value, label = '提示词') {
  // UTF-16 length is conservative for non-BMP characters as well.
  if (value.length <= KLING_PROMPT_LIMIT) return;
  throw Object.assign(new Error(`可灵${label}共 ${value.length} 个字符，最多 ${KLING_PROMPT_LIMIT} 个。请将正向或反向描述再缩短至少 ${value.length - KLING_PROMPT_LIMIT} 个字符；内容未截断，请求尚未提交。`), { status: 400 });
}
