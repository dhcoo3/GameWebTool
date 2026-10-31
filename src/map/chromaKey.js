// Local removal of the dedicated magenta background requested from Gemini.
// Reference-matching purple artwork is protected; enclosed background islands
// are treated exactly like exterior background, without another model request.
export const MATTE_VERSION = 2;
function keyColor(pixels, i, weak = false) {
  const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], lo = Math.min(r, b), hi = Math.max(r, b), excess = lo - g;
  return lo >= 24 && excess >= (weak ? 7 : 20) && excess / Math.max(1, hi) >= (weak ? .12 : .28) && lo / Math.max(1, hi) >= .48;
}
function referenceMatch(pixels, reference, i) {
  return reference && reference[i + 3] >= 8 && keyColor(reference, i, true)
    && Math.max(Math.abs(pixels[i] - reference[i]), Math.abs(pixels[i + 1] - reference[i + 1]), Math.abs(pixels[i + 2] - reference[i + 2])) <= 70;
}
export function inspectMagenta(pixels, reference) {
  let remainingPixels = 0, protectedPixels = 0, clearPixels = 0, visiblePixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 8) { clearPixels++; continue; }
    visiblePixels++;
    if (keyColor(pixels, i)) { if (referenceMatch(pixels, reference, i)) protectedPixels++; else remainingPixels++; }
  }
  return { remainingPixels, protectedPixels, clearPixels, visiblePixels };
}
export function cleanMagenta(pixels, width, height, reference) {
  const count = width * height;
  if (!Number.isInteger(count) || count < 1 || count > 32_000_000 || pixels.length !== count * 4 || reference && reference.length !== pixels.length) throw new Error('物件层清理尺寸无效或超出安全范围。');
  const background = new Uint8Array(count);
  let removedPixels = 0, decontaminatedPixels = 0;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (pixels[i + 3] < 8) background[p] = 1;
    else if (keyColor(pixels, i) && !referenceMatch(pixels, reference, i)) {
      pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 0;
      background[p] = 1; removedPixels++;
    }
  }
  // Despill mixed JPEG/antialiased pixels next to the newly clear background.
  // No global erosion or blur: non-magenta object pixels are never modified.
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (background[p] || !keyColor(pixels, i, true) || referenceMatch(pixels, reference, i)) continue;
    const x = p % width, y = Math.floor(p / width);
    let adjacent = false;
    for (let dy = -2; dy <= 2 && !adjacent; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height && background[p + dy * width + dx]) { adjacent = true; break; }
    }
    if (!adjacent) continue;
    const excess = Math.max(0, Math.min(pixels[i], pixels[i + 2]) - pixels[i + 1]);
    const coverage = Math.max(0, 1 - 1.5 * excess / Math.max(1, pixels[i], pixels[i + 2]));
    pixels[i] -= excess; pixels[i + 2] -= excess;
    pixels[i + 3] = Math.round(pixels[i + 3] * coverage); decontaminatedPixels++;
  }
  return { version: MATTE_VERSION, removedPixels, decontaminatedPixels, ...inspectMagenta(pixels, reference) };
}
export const matteValid = (stats) => stats?.version === MATTE_VERSION && stats.clearPixels > 0 && stats.visiblePixels > 0 && stats.remainingPixels === 0;
