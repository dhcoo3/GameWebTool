// Google image-generation resolution tables; K names are quality tiers, not long-edge limits.
// https://ai.google.dev/gemini-api/docs/image-generation
const DIMENSIONS = {
  '1:1': [1024, 1024], '4:3': [1200, 896], '3:2': [1264, 848],
  '16:9': [1376, 768], '5:4': [1152, 928], '4:5': [928, 1152],
  '3:4': [896, 1200], '2:3': [848, 1264], '9:16': [768, 1376], '21:9': [1584, 672],
};
const HIGH_RES_MODELS = new Set([
  'gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image', 'gemini-3-pro-image-preview', 'gemini-3.1-pro-image', 'gemini-3.1-pro-image-preview',
]);
export const DEFAULT_GEMINI_MODEL = 'gemini-nano-banana-2.1';
export const GEMINI_GROUND_RESOLUTIONS = ['auto', '1K', '2K', '4K'];
export const MAP_REQUEST_LIMIT = 36 * 1024 * 1024;

export function geminiResolutions(model) {
  if (HIGH_RES_MODELS.has(model)) return ['native', ...(['gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview'].includes(model) ? ['512'] : []), '1K', '2K', '4K'];
  if (model === 'gemini-3.1-flash-lite-image') return ['native', '1K'];
  return ['native'];
}
export function validateGeminiResolution(model, resolution = 'native') {
  if (!geminiResolutions(model).includes(resolution)) throw Object.assign(new Error(`当前 Gemini 模型 ${model} 不支持 ${resolution} 输出。请求尚未提交，请调整尺寸或模型。`), { status: 400 });
  return resolution;
}
export const resolutionLabel = (value) => value === 'native' ? '服务原生尺寸' : value === '512' ? '512 · 0.5K' : value;

export function geminiGroundResolutions(model) {
  if (HIGH_RES_MODELS.has(model)) return [...GEMINI_GROUND_RESOLUTIONS];
  if (model === 'gemini-3.1-flash-lite-image') return ['auto', '1K'];
  return ['auto'];
}
export function geminiAspectRatio(width, height) {
  const ratio = width / height;
  return Object.keys(DIMENSIONS).reduce((best, key) => {
    const value = (s) => { const [w, h] = s.split(':').map(Number); return w / h; };
    return Math.abs(Math.log(ratio / value(key))) < Math.abs(Math.log(ratio / value(best))) ? key : best;
  }, '1:1');
}
export function geminiGroundFrame(width, height) {
  const aspectRatio = geminiAspectRatio(width, height), [rw, rh] = aspectRatio.split(':').map(Number);
  const units = Math.ceil(Math.max(width / rw, height / rh));
  const w = units * rw, h = units * rh;
  return { width: w, height: h, x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2), aspectRatio };
}
export function resolveGeminiGround(model, requested = 'auto', width, height) {
  const choice = requested === 'native' ? 'auto' : requested;
  const supported = geminiGroundResolutions(model);
  if (!supported.includes(choice)) throw Object.assign(new Error(`当前 Gemini 模型 ${model} 不支持地面层 ${choice} 输出。请求尚未提交，请调整质量或模型。`), { status: 400 });
  const aspectRatio = geminiAspectRatio(width, height);
  if (supported.length === 1) return { requestedResolution: requested, resolvedResolution: 'native', aspectRatio,
    warning: '该模型没有已确认的高分辨率档位，使用服务默认输出；请检查实际返回尺寸。' };
  const tiers = supported.filter((v) => v !== 'auto');
  const dimensions = (tier) => { const n = Number(tier.slice(0, -1)); return DIMENSIONS[aspectRatio].map((v) => v * n); };
  const fits = (tier) => { const [w, h] = dimensions(tier); return w >= width && h >= height; };
  const resolvedResolution = choice === 'auto' ? tiers.find(fits) || tiers.at(-1) : choice;
  const [expectedWidth, expectedHeight] = dimensions(resolvedResolution);
  return { requestedResolution: requested, resolvedResolution, aspectRatio, expectedWidth, expectedHeight,
    warning: fits(resolvedResolution) ? '' : choice === 'auto' ? '原图超过模型最高输出档位，结果对齐时需要放大。' : '所选档位小于参考画幅，结果对齐时需要放大。' };
}
