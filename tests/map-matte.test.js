import test from 'node:test';
import assert from 'node:assert/strict';
import { mattePartPlan } from '../src/map/images.js';
import { collectAssetIds, newProject, normalizeProject } from '../src/map/core.js';

test('物件蒙版 1×1、2×2、3×3 分段覆盖非整除图块且带邻接参考边', () => {
  const width = 101, height = 65;
  for (const divisions of [1, 2, 3]) {
    const parts = mattePartPlan(width, height, divisions), coverage = new Uint8Array(width * height);
    assert.equal(parts.length, divisions ** 2);
    for (const { rect, reference } of parts) {
      assert.ok(reference.x >= 0 && reference.y >= 0);
      assert.ok(reference.x + reference.width <= width && reference.y + reference.height <= height);
      assert.ok(reference.x <= rect.x && reference.y <= rect.y);
      assert.ok(reference.x + reference.width >= rect.x + rect.width);
      assert.ok(reference.y + reference.height >= rect.y + rect.height);
      for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) coverage[y * width + x]++;
    }
    assert.ok(coverage.every((count) => count === 1), `${divisions}×${divisions} 分段出现空洞或重叠核心区`);
  }
  const single = mattePartPlan(3840, 2176, 1)[0];
  assert.deepEqual(single.reference, { x: 0, y: 0, width: 3840, height: 2176 });
});

test('蒙版队列重开时暂停，保留失败和已完成分段素材引用', () => {
  const saved = { ...newProject(), layerQueue: {
    id: 'mask-batch', status: 'running', subdivisions: 2, concurrency: 1,
    tasks: [{ id: 'task', tileId: 'tile', x: 0, y: 0, status: 'running', completedParts: [{ index: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, assetId: 'mask-part' }] }],
    baseline: { tiles: [{ originalId: 'source' }], layerQueue: null },
  } };
  const restored = normalizeProject(saved);
  assert.equal(restored.layerQueue.status, 'paused');
  assert.equal(restored.layerQueue.tasks[0].status, 'waiting');
  assert.equal(restored.layerQueue.tasks[0].completedParts[0].assetId, 'mask-part');
  assert.deepEqual(collectAssetIds(restored).sort(), ['mask-part', 'source']);
});

test('默认物件蒙版使用完整实体规则和动态画幅，前后端一致且保留自定义', async () => {
  const { layerGenerationPrompts } = await import('../src/map/layerPrompts.js');
  const { validateMapRequest } = await import('../server/map.js');
  const { klingMapPrompts, KLING_PROMPT_LIMIT } = await import('../server/klingPrompt.js');
  for (const [width, height] of [[1920, 1024], [640, 360]]) {
    const expected = layerGenerationPrompts('matte', width, height).prompt;
    assert.ok(expected.includes(`exactly ${width}×${height} pixels`));
    assert.match(expected, /Dark coloration alone does not indicate an opening/);
    assert.match(expected, /Preserve narrow connecting parts/);
    assert.match(expected, /union of their visible silhouettes white/);
    assert.ok(!expected.includes('Match the original art style'));
    assert.ok(expected.length < KLING_PROMPT_LIMIT);
    for (const provider of ['gemini', 'openai', 'qwen', 'kling']) {
      const request = validateMapRequest({ provider, operation: 'matte', width, height, imageBase64: 'mock' });
      assert.equal(request.prompt, expected);
      if (provider === 'kling') assert.equal(klingMapPrompts(request).prompt, expected);
    }
    assert.equal(layerGenerationPrompts('matte', width, height, '用户自定义蒙版规则').prompt, '用户自定义蒙版规则');
  }
});
