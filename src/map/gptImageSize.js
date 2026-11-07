export const supportsGptCustomSize = (model = '') => /^gpt-image-2(?:\.|$)/i.test(model);
export const gptImageResolutions = (model = '') => supportsGptCustomSize(model) ? ['native', 'match', '2K', '4K'] : ['native'];

// GPT Image 2 custom dimensions are multiples of 16 and have a limited pixel budget.
export function gptImageSize(width, height, resolution) {
  const w = Number(width), h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w / h > 3 || h / w > 3) throw new Error('地图画幅比例超出模型支持范围（1:3 至 3:1）。');
  if (!['match', '2K', '4K'].includes(resolution)) throw new Error('图像输出尺寸无效。');
  const maxPixels = 8294400, minPixels = 655360;
  const desired = resolution === 'match' ? Math.max(w, h) : resolution === '2K' ? 2048 : 3840;
  const scale = Math.min(desired / Math.max(w, h), 3840 / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
  let outW = Math.max(16, Math.floor(w * scale / 16) * 16), outH = Math.max(16, Math.floor(h * scale / 16) * 16);
  if (outW * outH < minPixels) {
    const factor = Math.sqrt(minPixels / (outW * outH));
    outW = Math.ceil(outW * factor / 16) * 16; outH = Math.ceil(outH * factor / 16) * 16;
  }
  if (outW > 3840 || outH > 3840 || outW * outH > maxPixels || outW * outH < minPixels || outW / outH > 3 || outH / outW > 3) throw new Error('无法为此地图画幅计算有效的模型输出尺寸。');
  return { width: outW, height: outH };
}
