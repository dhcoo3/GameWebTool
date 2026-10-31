import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiGroundFrame, geminiGroundResolutions, geminiResolutions, resolveGeminiGround, DEFAULT_GEMINI_MODEL } from '../src/map/geminiResolution.js';
import { newProject, normalizeProject, collectAssetIds } from '../src/map/core.js';
import { validateMapRequest } from '../server/map.js';
import { generateWithGemini } from '../server/index.js';

const model = DEFAULT_GEMINI_MODEL;
const request = { provider: 'gemini', operation: 'ground', width: 3872, height: 2178, imageBase64: 'fixture', resolution: 'auto' };
test('通用尺寸按模型显示全部支持档位，未知模型和旧项目不会被静默改档', () => {
  assert.deepEqual(geminiResolutions(model), ['native', '1K', '2K', '4K']);
  assert.deepEqual(geminiResolutions('gemini-3.1-flash-image'), ['native', '512', '1K', '2K', '4K']);
  assert.deepEqual(geminiResolutions('gemini-3.1-flash-lite-image'), ['native', '1K']);
  assert.deepEqual(geminiResolutions('unknown-model'), ['native']);
  assert.equal(normalizeProject({ resolution: '4K' }).resolution, '4K');
});
test('Gemini 全部通用档位贯穿各地图操作，512 使用 Interactions API 枚举，非法模型档位不提交', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ output_image: { data: 'fixture', mime_type: 'image/jpeg' } }); };
  try {
    for (const operation of ['seed', 'expand', 'retouch', 'objects', 'matte']) for (const resolution of ['native', '1K', '2K', '4K']) {
      const body = validateMapRequest({ ...request, operation, resolution, prompt: 'forest' }, { geminiModel: model });
      const before = calls.length;
      await generateWithGemini({ geminiModel: model, geminiKey: 'mock' }, body);
      assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).response_format.image_size, resolution === 'native' ? '1K' : resolution);
    }
    const flash = 'gemini-3.1-flash-image';
    const small = validateMapRequest({ ...request, operation: 'expand', resolution: '512' }, { geminiModel: flash });
    await generateWithGemini({ geminiModel: flash }, small); assert.equal(calls.at(-1).response_format.image_size, '512');
    const count = calls.length;
    for (const [unsupported, resolution] of [[model, '512'], ['gemini-3.1-flash-lite-image', '4K'], ['custom-image', '2K']]) {
      assert.throws(() => validateMapRequest({ ...request, operation: 'expand', resolution }, { geminiModel: unsupported }), /不支持/);
      await assert.rejects(generateWithGemini({ geminiModel: unsupported }, { ...request, operation: 'expand', resolution }), /请求尚未提交/);
    }
    assert.equal(calls.length, count);
  } finally { globalThis.fetch = original; }
});
test('Gemini 自动质量使用实际画幅尺寸，4K 地图和竖图选择正确；最高档不足时提示', () => {
  assert.deepEqual(geminiGroundFrame(3840, 2176), { width: 3872, height: 2178, x: 16, y: 1, aspectRatio: '16:9' });
  for (const [w, h, expected] of [[1024, 1024, '1K'], [2048, 2048, '2K'], [3840, 2176, '4K'], [2176, 3840, '4K'], [2752, 1536, '2K']]) {
    assert.equal(resolveGeminiGround(model, 'auto', w, h).resolvedResolution, expected);
  }
  const huge = resolveGeminiGround(model, 'auto', 8192, 8192);
  assert.equal(huge.resolvedResolution, '4K'); assert.match(huge.warning, /最高输出档位/);
  assert.match(resolveGeminiGround(model, '1K', 3840, 2176).warning, /需要放大/);
});
test('模型能力明确区分高分辨率、Lite 和未知模型，非法档位在提交前拒绝', () => {
  assert.deepEqual(geminiGroundResolutions(model), ['auto', '1K', '2K', '4K']);
  assert.deepEqual(geminiGroundResolutions('gemini-3.1-flash-lite-image'), ['auto', '1K']);
  for (const unknown of ['custom-image', 'gemini-2.5-flash-image']) {
    assert.deepEqual(geminiGroundResolutions(unknown), ['auto']);
    assert.equal(resolveGeminiGround(unknown, 'auto', 3840, 2176).resolvedResolution, 'native');
    assert.throws(() => validateMapRequest({ ...request, resolution: '4K' }, { geminiModel: unknown }), /请求尚未提交/);
  }
  assert.throws(() => validateMapRequest({ ...request, operation: 'expand' }), /不支持所选输出分辨率/);
  assert.throws(() => validateMapRequest({ ...request, provider: 'qwen' }), /不支持所选输出分辨率/);
});
test('地面层默认和项目引用兼容旧数据；默认提示词保细节，自定义内容原样保留', () => {
  assert.equal(newProject().groundResolution, 'auto');
  assert.equal(normalizeProject({ tiles: [] }).groundResolution, 'auto');
  assert.equal(normalizeProject({ tiles: [], groundResolution: '4K' }).groundResolution, '4K');
  assert.equal(normalizeProject({ tiles: [], groundResolution: 'invalid' }).groundResolution, 'auto');
  assert.deepEqual(collectAssetIds({ tiles: [{ groundRawAssetId: 'raw', groundId: 'aligned' }] }).sort(), ['aligned', 'raw']);
  const body = validateMapRequest({ ...request, prompt: 'FORBIDDEN_VILLAGE', negativePrompt: 'FORBIDDEN_NEGATIVE' });
  assert.match(body.prompt, /local contrast/); assert.match(body.prompt, /do not smooth, blur/);
  assert.ok(!body.prompt.includes('FORBIDDEN_')); assert.equal(body.negativePrompt, '');
  assert.equal(validateMapRequest({ ...request, layerPrompt: 'CUSTOM ground instructions\n保留草地纹理' }).prompt, 'CUSTOM ground instructions\n保留草地纹理');
});
test('Gemini 地面请求一次，自动/手动档位和元数据正确；未知模型省略 image_size，失败不降档重试', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ output_image: { data: 'raw-jpeg', mime_type: 'image/jpeg' } }); };
  try {
    const settings = { geminiKey: 'mock', geminiModel: model };
    for (const resolution of ['auto', '1K', '2K', '4K']) {
      const before = calls.length;
      const result = await generateWithGemini(settings, { ...request, resolution });
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).response_format.image_size, resolution === 'auto' ? '4K' : resolution);
      assert.equal(calls.at(-1).input[1].data, 'fixture');
      assert.equal(result.generation.model, model); assert.equal(result.generation.requestedResolution, resolution);
      assert.equal(result.mimeType, 'image/jpeg'); assert.equal(result.data, 'raw-jpeg');
    }
    const unknown = await generateWithGemini({ ...settings, geminiModel: 'custom-model' }, request);
    assert.equal(calls.at(-1).response_format.image_size, undefined); assert.equal(unknown.generation.resolvedResolution, 'native');
    const count = calls.length;
    await assert.rejects(generateWithGemini({ ...settings, geminiModel: 'gemini-3.1-flash-lite-image' }, { ...request, resolution: '4K' }), /请求尚未提交/);
    assert.equal(calls.length, count);
    let failures = 0;
    globalThis.fetch = async () => { failures++; return Response.json({ error: { message: 'MOCK 4K failure' } }, { status: 429 }); };
    await assert.rejects(generateWithGemini(settings, request), /MOCK 4K failure/); assert.equal(failures, 1);
  } finally { globalThis.fetch = original; }
});
