import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMagenta, inspectMagenta, matteValid } from '../src/map/chromaKey.js';
import { validLayerPair } from '../src/map/layers.js';

function image(w, h, color) { const a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < a.length; i += 4) a.set(color, i); return a; }
test('洋红底包含封闭孔洞和暗紫区域，原图中的紫色物件和非紫色像素保持原值', () => {
  const w = 32, h = 24, reference = image(w, h, [65, 60, 45, 255]), pixels = image(w, h, [255, 0, 255, 255]);
  const set = (a, x, y, rgba) => a.set(rgba, (y * w + x) * 4);
  for (let y = 6; y < 20; y++) for (let x = 8; x < 24; x++) set(pixels, x, y, [45, 95, 35, 255]);
  set(pixels, 15, 12, [60, 8, 70, 255]); // enclosed hole
  set(pixels, 10, 10, [160, 50, 180, 255]); set(reference, 10, 10, [160, 50, 180, 255]);
  const stats = cleanMagenta(pixels, w, h, reference);
  assert.equal(pixels[(12 * w + 15) * 4 + 3], 0);
  assert.deepEqual([...pixels.slice((10 * w + 10) * 4, (10 * w + 10) * 4 + 4)], [160, 50, 180, 255]);
  assert.deepEqual([...pixels.slice((11 * w + 11) * 4, (11 * w + 11) * 4 + 4)], [45, 95, 35, 255]);
  assert.equal(stats.protectedPixels, 1); assert.equal(stats.remainingPixels, 0); assert.ok(matteValid(stats));
});
test('已有透明图也可清理内部残留，混色边缘去紫，重复处理不持续侵蚀对象', () => {
  const w = 12, h = 12, pixels = image(w, h, [0, 0, 0, 0]);
  const set = (x, y, rgba) => pixels.set(rgba, (y * w + x) * 4);
  set(5, 5, [40, 90, 35, 255]); set(6, 5, [100, 80, 110, 255]); set(8, 8, [100, 15, 120, 255]);
  const before = inspectMagenta(pixels); assert.equal(before.remainingPixels, 1);
  const stats = cleanMagenta(pixels, w, h); assert.equal(stats.removedPixels, 1); assert.equal(stats.decontaminatedPixels, 1);
  assert.ok(pixels[(5 * w + 6) * 4 + 3] < 255); assert.ok(matteValid(stats));
  const saved = pixels.slice(); cleanMagenta(pixels, w, h); assert.deepEqual(pixels, saved);
});
test('仅有透明像素不能通过 Gemini 紫底验收，缺少检查的旧层禁止直接接纳', () => {
  const p = image(4, 4, [255, 0, 255, 255]); p[3] = 0;
  assert.equal(matteValid({ version: 2, ...inspectMagenta(p) }), false);
  const draft = { layerMode: 'direct', objectsId: 'o', groundId: 'g', objectsValid: true, groundValid: true, objectsGeneration: { model: 'gemini-nano-banana-2.1' } };
  assert.equal(validLayerPair(draft), false);
  assert.equal(validLayerPair({ ...draft, objectsMatteStats: cleanMagenta(p, 4, 4) }), false); // all background, no object
  assert.equal(validLayerPair({ ...draft, objectsMatteStats: { version: 2, clearPixels: 1, visiblePixels: 2, remainingPixels: 0 } }), true);
  assert.throws(() => cleanMagenta(p, 100, 100), /尺寸无效/);
});
