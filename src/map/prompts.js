import { scalePrompt } from './scale.js';

const FRAME_RULES = {
  seed: 'Map framing requirement: create a rectangular crop of a continuous game world. Terrain must fill the entire image, including ALL FOUR CORNERS and all four outer edges. Isometric or 45-degree describes the camera angle ONLY, not the outline of the map. Do not compose an isolated diamond-shaped or rhombus-shaped map, floating island, miniature diorama, raised slab, or presentation board. No black, solid-color or transparent padding around the terrain and no visible cutaway side walls. A reference does not define the map outline or object sizes; follow its explicitly assigned role and ignore any isolated outline or backdrop.',
  expand: 'Map framing requirement: continue one continuous game world into the rectangular editable area. Treat every boundary between protected and editable pixels as an invisible crop through the same image, never as a wall, horizon, border or composition edge. Keep the SAME orthographic camera zoom and map-pixel dimensions of comparable objects in the reference: paving stones, door openings, fence posts, wheels, barrels and tree trunks. Do not shrink existing object categories to fit more scenery. Continue roads, paths, wall courses, roof edges, fences, shorelines, paving patterns, grass and shadows across the boundary with matching direction, width, spacing, scale, detail density, material, palette and light. Match the neighboring pixels immediately along every edge; avoid any straight horizontal or vertical band, abrupt brightness or color step, change in texture scale, blur, smudge, repeated landmark or duplicated structure. Where a feature reaches the boundary, continue that exact feature naturally instead of starting a new one. Fill the editable corners with connected terrain. Isometric or 45-degree describes the camera angle ONLY, not a diamond-shaped terrain outline. Do not add a new isolated diorama, floating slab, presentation board or background padding. Preserve ALL protected content exactly, even when it contains existing dark or empty areas.',
};
const FRAME_NEGATIVES = ['diamond-shaped map outline', 'rhombus-shaped map outline', 'floating terrain slab', 'isolated diorama', 'presentation board', 'black corner padding', 'solid-color backdrop outside the terrain', 'transparent corner padding', 'cutaway outer side walls'];
const EXPAND_NEGATIVES = ['visible tile seam', 'straight seam line', 'hard rectangular cut', 'horizontal color band', 'vertical color band', 'abrupt lighting transition', 'abrupt texture transition', 'blurred transition', 'repeated edge detail'];
const SIMPLE_EXPAND_RULE = 'Complete the marked empty area as a continuation of the existing map. Match its art style, perspective, object scale, colors and lighting. Continue roads, terrain and objects naturally across the boundary. Keep the same framing and fill the marked area.';

export function mapUserPrompts(operation, prompt, negativePrompt) {
  return {
    prompt: String(prompt || '').replace(FRAME_RULES[operation] || '\u0000', '').replace(SIMPLE_EXPAND_RULE, '').replace(/\[MAP_SCALE_REFERENCE\][\s\S]*?\[\/MAP_SCALE_REFERENCE\]/g, '').trim().slice(0, 8000),
    negativePrompt: String(negativePrompt || '').split(/[,，\n]+/).map((term) => term.trim()).filter((term) => term && !(FRAME_RULES[operation] && FRAME_NEGATIVES.includes(term)) && !(operation === 'expand' && EXPAND_NEGATIVES.includes(term))).join(', '),
  };
}

export function mapGenerationPrompts(operation, prompt, negativePrompt, scaleReference) {
  const rule = FRAME_RULES[operation];
  const scale = ['seed', 'expand', 'retouch'].includes(operation) ? scalePrompt(scaleReference, { referenceLocked: operation === 'expand' }) : '';
  if (!rule && !scale) return { prompt: String(prompt || ''), negativePrompt: String(negativePrompt || '') };
  // Both the browser and API apply the rule so existing running services receive it too.
  // Remove the known prefix first to keep repeated normalization idempotent.
  const userPrompt = mapUserPrompts(operation, prompt, negativePrompt).prompt;
  const negativeTerms = String(negativePrompt || '').split(/[,，\n]+/).map((term) => term.trim()).filter(Boolean);
  return {
    prompt: [rule, scale, userPrompt].filter(Boolean).join('\n\n'),
    negativePrompt: [...new Set([...(rule ? FRAME_NEGATIVES : []), ...(operation === 'expand' ? EXPAND_NEGATIVES : []), ...negativeTerms])].join(', ').slice(0, 4000),
  };
}

// Keep project rules separate on the wire; only the API combines them with local prompts.
export function mapGlobalPrompts(operation, prompts, rules = {}) {
  if (!['seed', 'expand', 'retouch'].includes(operation)) return prompts;
  const positive = typeof rules.globalPositivePrompt === 'string' ? rules.globalPositivePrompt.trim() : '';
  const negative = typeof rules.globalNegativePrompt === 'string' ? rules.globalNegativePrompt.trim() : '';
  if (!positive && !negative) return prompts;
  return {
    prompt: [positive && `Global art rules (follow throughout the map):\n${positive}`, prompts.prompt].filter(Boolean).join('\n\n'),
    negativePrompt: [...new Set([negative, prompts.negativePrompt].filter(Boolean).flatMap((value) => value.split(/[,，\n]+/)).map((term) => term.trim()).filter(Boolean))].join(', '),
  };
}
