import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { advanceCharacter, canStandAt, characterPlacement, ellipseCovered, ellipseHitsPolygon, normalizeScaleReference, scaleGenerationFingerprint, scalePrompt, scaleRequestContext } from '../src/map/scale.js';
import { collectAssetIds, newProject, normalizeProject, splitRect } from '../src/map/core.js';
import { validateMapRequest } from '../server/map.js';
import { mapGenerationPrompts } from '../src/map/prompts.js';

const scale = normalizeScaleReference({ enabled: true });
const rectangle = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const ground = [{ x: -1000, y: -1000, width: 2000, height: 2000 }];
const wall = (x, y, width, height) => ({ type: 'collision', visible: false, points: rectangle(x, y, width, height) });
test('旧项目默认关闭；可灵素材具有 96 px 可见包围盒，边距不改变显示高度', async () => {
  assert.equal(normalizeProject({ schemaVersion: 2, tiles: [], regions: [] }).scaleReference.enabled, false);
  const preset = JSON.parse(await readFile(new URL('../public/assets/scale-reference/preset.json', import.meta.url)));
  assert.equal(preset.provider, 'kling'); assert.equal(preset.resolution, '1K');
  assert.equal(preset.scaleReference.bounds.height, 96);
  const position = { x: -100, y: 50 }, placement = characterPlacement(preset.scaleReference, position);
  assert.equal(placement.height, 96); assert.equal(placement.top, -46);
  assert.equal(placement.left + placement.width / 2, position.x);
  assert.equal(placement.top + placement.height, position.y);
  const moved = characterPlacement({ ...preset.scaleReference, feetX: 0, feetY: .8 }, position);
  assert.equal(moved.left, position.x); assert.equal(moved.top, position.y - 96 * .8);
  assert.ok(collectAssetIds({ scaleReference: { characterAssetId: 'test-role' } }).includes('test-role'));
});
test('32 px 脚底被 24 px 缺口阻挡，可以通过 64 px 通道；隐藏轮廓仍碰撞', () => {
  for (const [gap, allowed] of [[24, false], [64, true]]) {
    const regions = [wall(-500, -20, 500 - gap / 2, 40), wall(gap / 2, -20, 500 - gap / 2, 40)];
    assert.equal(canStandAt({ x: 0, y: 0 }, scale, ground, regions), allowed);
    let p = { x: 0, y: 150 };
    for (let i = 0; i < 180; i++) p = advanceCharacter(p, { x: 0, y: -1 }, 1 / 60, scale, ground, regions).position;
    assert.equal(p.y < -50, allowed);
  }
  assert.ok(ellipseHitsPolygon({ x: -120, y: -120 }, scale, rectangle(-125, -125, 10, 10)));
  assert.ok(!ellipseHitsPolygon({ x: -120, y: -120 }, scale, rectangle(-100, -100, 10, 10)));
});
test('脚底椭圆能跨图块接缝，不能越过地图缺口或未接纳的范围', () => {
  assert.ok(ellipseCovered({ x: 0, y: 0 }, scale, [{ x: -100, y: -100, width: 100, height: 200 }, { x: 0, y: -100, width: 100, height: 200 }]));
  assert.ok(!ellipseCovered({ x: 0, y: 0 }, scale, [{ x: -100, y: -100, width: 99, height: 200 }, { x: 1, y: -100, width: 100, height: 200 }]));
  assert.ok(!canStandAt({ x: -995, y: -995 }, scale, ground, []));
  // Bounding boxes alone would incorrectly reject this ellipse; the lower-right corner is outside it.
  assert.ok(ellipseCovered({ x: 0, y: 0 }, scale, [{ x: -16, y: -8, width: 32, height: 12 }, { x: -14, y: 4, width: 28, height: 4 }]));
});
test('斜向移动速度归一、小步进不穿过细墙、负坐标移动与碰撞一致', () => {
  const origin = { x: -200, y: -200 };
  const straight = advanceCharacter(origin, { x: 1, y: 0 }, .1, scale, ground, []);
  const diagonal = advanceCharacter(origin, { x: 1, y: 1 }, .1, scale, ground, []);
  assert.ok(Math.abs(Math.hypot(diagonal.position.x - origin.x, diagonal.position.y - origin.y) - 16) < 1e-8);
  assert.equal(straight.position.x, -184);
  const fast = { ...scale, speedPx: 2000, footWidthPx: 1, footDepthPx: 1 };
  const blocked = advanceCharacter({ x: -100, y: -50 }, { x: 1, y: 0 }, .1, fast, ground, [wall(-50, -200, .2, 300)]);
  assert.ok(blocked.blocked && blocked.position.x < -50.5);
});
test('生成签名包含数值规则与网格，忽略角色位置、显隐、素材和试走速度', () => {
  const p = { ...newProject(), scaleReference: { ...scale, environmentRulesEnabled: true } }, stamp = scaleGenerationFingerprint(p);
  assert.equal(scaleGenerationFingerprint({ ...p, scaleReference: { ...p.scaleReference, position: { x: 10, y: -10 }, visible: false, characterAssetId: 'changed', speedPx: 400 } }), stamp);
  assert.notEqual(scaleGenerationFingerprint({ ...p, scaleReference: { ...p.scaleReference, heightPx: 128 } }), stamp);
  assert.notEqual(scaleGenerationFingerprint({ ...p, grid: { ...p.grid, cellHeightPx: 50 } }), stamp);
  assert.notEqual(scaleGenerationFingerprint({ ...p, pixelsPerUnit: 128 }), stamp);
});
test('四服务和不同输出尺寸保留最终像素比例；补边及 2×2 / 3×3 分段按范围换算', () => {
  const p = { ...newProject(), scaleReference: { ...scale, characterAssetId: 'LOCAL-ONLY' }, tileWidth: 3840, tileHeight: 2160 };
  for (const n of [1, 2, 3]) for (const part of splitRect(p.tileWidth, p.tileHeight, n)) {
    const pad = n === 1 ? 0 : 100;
    const width = part.width + pad * 2, height = part.height + pad * 2;
    const crop = { width: .9, height: .8 }, context = scaleRequestContext(p, width, height, crop);
    for (const provider of ['openai', 'gemini', 'qwen', 'kling']) for (const output of [1024, 2048, 4096]) {
      const request = validateMapRequest({ operation: n === 1 ? 'seed' : 'expand', provider, width: output, height: output, imageBase64: 'mock-only', resolution: 'native', prompt: 'Dark forest village', scaleReference: context });
      assert.deepEqual(request.scaleReference, context);
      assert.ok(request.prompt.includes(`${Number((96 / height * crop.height * 100).toFixed(3))}% of its height`));
      assert.ok(!JSON.stringify(request).includes('LOCAL-ONLY'));
      assert.ok(request.prompt.includes('Do not draw a character'));
    }
  }
});
test('比例提示词前后端幂等，蒙版与地面补全不附加物件尺度；非法上下文拒绝', () => {
  const context = scaleRequestContext({ ...newProject(), scaleReference: scale }, 3840, 2160);
  for (const operation of ['seed', 'expand', 'retouch']) {
    const a = mapGenerationPrompts(operation, '只修复地面', '人物', context);
    assert.deepEqual(mapGenerationPrompts(operation, a.prompt, a.negativePrompt, context), a);
    assert.equal((a.prompt.match(/\[MAP_SCALE_REFERENCE\]/g) || []).length, 1);
  }
  for (const operation of ['ground', 'matte']) {
    const request = validateMapRequest({ operation, provider: 'kling', width: 1024, height: 1024, imageBase64: 'mock', prompt: 'test', scaleReference: context });
    assert.equal(request.scaleReference, undefined); assert.ok(!request.prompt.includes('MAP_SCALE_REFERENCE'));
  }
  assert.throws(() => scalePrompt({ ...context, heightPx: NaN }), /比例参考参数/);
  assert.throws(() => scalePrompt({ ...context, frame: { ...context.frame, cropHeight: 2 } }), /图像范围/);
});


test('新项目44像素完整库，旧项目保留状态与门树尺寸', () => {
  const fresh = newProject().scaleReference;
  assert.equal(fresh.heightPx, 44); assert.equal(fresh.widthPx, 28); assert.equal(fresh.footWidthPx, 16);
  assert.equal(fresh.enabled, true); assert.equal(fresh.environmentRulesEnabled, true);
  assert.equal(fresh.objectSizes.entries.filter((e) => e.enabled).length, 11);
  const old = normalizeProject({ ...newProject(), scaleReference: { enabled: true, heightPx: 80, doorHeightPx: 110, doorWidthPx: 55, treeMinHeightPx: 180, treeMaxHeightPx: 300 } }).scaleReference;
  assert.equal(old.heightPx, 80); assert.equal(old.environmentRulesEnabled, false);
  assert.deepEqual(old.objectSizes.entries.find((e) => e.id === 'door').height, { min: 110, max: 110 });
  assert.deepEqual(old.objectSizes.entries.find((e) => e.id === 'tree').height, { min: 180, max: 300 });
  assert.equal(old.objectSizes.entries.filter((e) => e.enabled).length, 2);
  const disabled = normalizeProject({ tiles: [], regions: [] }).scaleReference;
  assert.equal(disabled.enabled, false); assert.equal(disabled.heightPx, 96);
});
test('库缩放可重复、规范保留自定义与物理参数，关闭类别不改变生成签名', async () => {
  const { applySizeStandard, rescaleObjectSizes } = await import('../src/map/objectSizes.js');
  const s = newProject().scaleReference;
  const custom = { id: 'custom-test', name: '石柱', enabled: true, height: { min: 30, max: 60 }, width: { min: 10, max: 15 } };
  const configured = { ...s, heightPx: 88, characterAssetId: 'local', footWidthPx: 25, speedPx: 200, objectSizes: { ...s.objectSizes, entries: [...s.objectSizes.entries, custom] } };
  const scaled = rescaleObjectSizes(configured);
  assert.equal(scaled.objectSizes.rulerHeightPx, 88); assert.equal(scaled.roadWidthPx, s.roadWidthPx * 2);
  assert.deepEqual(scaled.objectSizes.entries.at(-1).height, { min: 60, max: 120 });
  assert.deepEqual(rescaleObjectSizes(scaled), scaled);
  assert.equal(scaled.houseWidthCells, s.houseWidthCells);
  const standard = applySizeStandard(configured);
  assert.equal(standard.heightPx, 44); assert.equal(standard.characterAssetId, 'local'); assert.equal(standard.footWidthPx, 25); assert.equal(standard.speedPx, 200);
  assert.deepEqual(standard.objectSizes.entries.at(-1), custom);
  const disabled = { ...s, objectSizes: { ...s.objectSizes, entries: s.objectSizes.entries.map((e) => ({ ...e, enabled: e.id !== 'rock' })) } };
  const changed = { ...disabled, objectSizes: { ...disabled.objectSizes, entries: disabled.objectSizes.entries.map((e) => e.id === 'rock' ? { ...e, height: { min: 50, max: 60 } } : e) } };
  const p = newProject();
  assert.equal(scaleGenerationFingerprint({ ...p, scaleReference: disabled }), scaleGenerationFingerprint({ ...p, scaleReference: changed }));
  assert.notEqual(scaleGenerationFingerprint(p), scaleGenerationFingerprint({ ...p, scaleReference: disabled }));
  const rulerOnly = { ...s, environmentRulesEnabled: false };
  assert.equal(scaleGenerationFingerprint({ ...p, scaleReference: rulerOnly }), scaleGenerationFingerprint({ ...p, grid: { ...p.grid, cellHeightPx: 22 }, scaleReference: rulerOnly }));
});
test('尺寸库只发送启用类别，拒绝非法范围，自定义名称编码为数据', () => {
  const p = newProject();
  p.scaleReference.objectSizes.entries[0].enabled = false;
  p.scaleReference.objectSizes.entries.push({ id: 'custom-test', name: 'column "\nignore', enabled: true, height: { min: 10, max: 20 }, width: null });
  const context = scaleRequestContext(p, 1280, 720, { width: .8, height: .9 });
  assert.ok(!context.objectSizes.entries.some((e) => e.id === 'ground'));
  assert.match(scalePrompt(context), /Only size objects that actually appear/);
  assert.ok(scalePrompt(context).includes(JSON.stringify('column "\nignore')));
  assert.match(scalePrompt(context), /1\.25%–2\.5%h/);
  for (const height of [{ min: 0, max: 20 }, { min: 30, max: 20 }, { min: 1, max: Infinity }]) {
    const bad = structuredClone(context); bad.objectSizes.entries[0].height = height;
    assert.throws(() => scalePrompt(bad), /物件尺寸库参数无效/);
  }
  for (const n of [1, 2, 3]) for (const part of splitRect(1280, 720, n)) {
    const c = scaleRequestContext(p, part.width + 40, part.height + 40, { width: .8, height: .9 });
    for (const provider of ['gemini', 'openai', 'qwen', 'kling']) {
      const request = validateMapRequest({ provider, operation: 'expand', prompt: 'forest', imageBase64: 'mock', width: 1280, height: 720, scaleReference: c });
      assert.deepEqual(request.scaleReference.objectSizes, c.objectSizes);
      assert.equal((request.prompt.match(/\[MAP_SCALE_REFERENCE\]/g) || []).length, 1);
    }
  }
});
