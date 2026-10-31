import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, normalizeProject } from '../src/map/core.js';
import { normalizeReferenceSettings, effectiveReference, STYLE_EXTRACTION_INSTRUCTIONS } from '../src/map/reference.js';
import { scaleRequestContext } from '../src/map/scale.js';
import { mapGenerationPrompts } from '../src/map/prompts.js';
import { validateMapRequest } from '../server/map.js';
import { mapDiagnostics } from '../server/providerPrompts.js';
import { generateWithGemini, generateWithOpenAI, generateWithQwen, generateWithKling, draftWithGemini, draftWithOpenAI, draftWithQwen } from '../server/index.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const settings = { geminiModel: 'gemini-nano-banana-2.1', geminiPromptModel: 'mock-text', geminiKey: 'mock', openaiModel: 'mock-image', openaiPromptModel: 'mock-text', openaiKey: 'mock', qwenImageModel: 'qwen-image-3.0-pro', qwenPromptModel: 'mock-text', qwenKey: 'mock', qwenBaseUrl: 'https://qwen.example.test', klingModel: 'mock-image', klingKey: 'mock', klingBaseUrl: 'https://kling.example.test' };
const generators = { gemini: generateWithGemini, openai: generateWithOpenAI, qwen: generateWithQwen, kling: generateWithKling };
const base = { operation: 'seed', provider: 'gemini', width: 1280, height: 720, imageBase64: png, prompt: 'SCENE_SENTINEL', negativePrompt: 'NEGATIVE_SENTINEL' };

test('参考设置旧项目默认兼容、取样合法性与有效模式', () => {
  const old = { ...newProject(), styleAssetId: 'original' }; delete old.referenceSettings;
  const p = normalizeProject(old);
  assert.deepEqual(p.referenceSettings, normalizeReferenceSettings()); assert.equal(p.styleAssetId, 'original');
  assert.equal(effectiveReference(p).mode, 'style');
  const text = { ...p, referenceSettings: { mode: 'style', input: 'text', positive: 'STYLE_TEXT' } };
  assert.equal(effectiveReference(text).hasImage, false); assert.equal(effectiveReference(text).positive, 'STYLE_TEXT');
  const layout = { ...text, referenceSettings: { ...text.referenceSettings, mode: 'layout', crop: { x: .1, y: .1, width: .5, height: .5 } } };
  assert.equal(effectiveReference(layout).hasImage, true); assert.equal(effectiveReference(layout).positive, ''); assert.equal(effectiveReference(layout).crop, null);
  for (const crop of [{ x: -1, y: 0, width: .5, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: .6, y: 0, width: .5, height: 1 }, { x: NaN, y: 0, width: .5, height: 1 }]) assert.equal(normalizeReferenceSettings({ crop }).crop, null);
  const crop = { x: .1, y: .2, width: .3, height: .4 };
  assert.deepEqual(normalizeReferenceSettings({ crop }).crop, crop);
});
test('三种参考用途按实际图片启用；文字模式剥离图片，比例优先且无规则重复', () => {
  const context = scaleRequestContext(newProject(), 1280, 720);
  for (const mode of ['style', 'layout', 'both']) for (const provider of Object.keys(generators)) {
    const local = mapGenerationPrompts('seed', base.prompt, base.negativePrompt, context);
    const request = validateMapRequest({ ...base, ...local, provider, scaleReference: context, reference: { mode, input: 'image' } }, settings);
    assert.match(request.prompt, /PRIORITY: the numeric character ruler/);
    assert.equal((request.prompt.match(/PRIORITY:/g) || []).length, 1);
    assert.equal((request.prompt.match(/\[MAP_SCALE_REFERENCE\]/g) || []).length, 1);
    assert.ok(!request.prompt.includes('detail scale'));
    if (mode === 'style') assert.match(request.prompt, /Design a NEW layout/);
    if (mode === 'layout') { assert.match(request.prompt, /ONLY for spatial relationships/); assert.ok(!request.prompt.includes('ONLY for palette')); }
    if (mode === 'both') assert.match(request.prompt, /AND spatial relationships/);
    const noImage = validateMapRequest({ ...base, provider, imageBase64: '', reference: { mode, input: 'image' } }, settings);
    assert.ok(!noImage.prompt.includes('Use the image ONLY'));
    const text = validateMapRequest({ ...base, provider, reference: { mode: 'style', input: 'text', positive: 'WRITTEN_STYLE', negative: 'STYLE_AVOID' } }, settings);
    assert.equal(text.imageBase64, ''); assert.match(text.prompt, /WRITTEN_STYLE/); assert.match(text.negativePrompt, /STYLE_AVOID/);
  }
  for (const operation of ['expand', 'retouch', 'ground', 'objects', 'matte']) {
    const request = validateMapRequest({ ...base, operation, reference: { mode: 'style', input: 'text', positive: 'NO_LEAK' } }, settings);
    assert.equal(request.imageBase64, png); assert.ok(!request.prompt.includes('NO_LEAK'));
  }
});
test('预览诊断与四服务实际请求完全一致；诊断没有图片和密钥', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), ...options }); return Response.json({ error: { message: 'MOCK_STOP' } }, { status: 429 }); };
  try {
    for (const provider of Object.keys(generators)) for (const mode of ['style', 'layout', 'both']) for (const hasImage of [true, false]) {
      calls.length = 0;
      const request = validateMapRequest({ ...base, provider, imageBase64: hasImage ? png : '', reference: { mode, input: 'image' }, scaleReference: scaleRequestContext(newProject(), 1280, 720) }, settings);
      const diagnostics = mapDiagnostics(settings, request, settings[`${provider}Model`] || settings.qwenImageModel);
      assert.equal(diagnostics.validationError, ''); assert.equal(diagnostics.scale.objectCount, 11);
      await assert.rejects(generators[provider](settings, request), /MOCK_STOP|请求失败/);
      assert.equal(calls.length, 1);
      const body = calls[0].body;
      let prompt, negative = '';
      if (typeof body !== 'string') prompt = body.get('prompt');
      else {
        const json = JSON.parse(body);
        if (provider === 'gemini') prompt = json.input[0].text;
        if (provider === 'qwen') { prompt = json.input.messages[0].content.find((c) => c.text).text; negative = json.parameters.negative_prompt || ''; }
        if (provider === 'kling' || provider === 'openai') { prompt = json.prompt; negative = json.negative_prompt || ''; }
      }
      assert.equal(prompt, diagnostics.prompt); assert.equal(negative, diagnostics.negativePrompt);
      assert.equal(diagnostics.hasImage, hasImage);
      assert.ok(!JSON.stringify(diagnostics).includes(png)); assert.ok(!JSON.stringify(diagnostics).includes('mock-key'));
    }
  } finally { globalThis.fetch = original; }
});
test('可灵超长的完整参考规则可预览且不截断，生成前拦截', async () => {
  const request = validateMapRequest({ ...base, provider: 'kling', reference: { mode: 'style', input: 'text', positive: 'x'.repeat(3000) + 'TAIL_STYLE' } }, settings);
  const diagnostics = mapDiagnostics(settings, request, 'mock-image');
  assert.match(diagnostics.prompt, /TAIL_STYLE/); assert.match(diagnostics.validationError, /内容未截断/);
  const original = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('unexpected'); };
  try { await assert.rejects(generateWithKling(settings, request), /请求尚未提交/); assert.equal(calls, 0); }
  finally { globalThis.fetch = original; }
});
test('三家风格提炼仅发送专用风格指令，返回可编辑正反向文字', async () => {
  const original = globalThis.fetch, calls = [], result = { prompt: '低饱和、大色块', negativePrompt: '模糊、渐变' };
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (String(url).includes('openai.com')) return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
    if (String(url).includes('googleapis.com')) return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  };
  try {
    for (const draft of [draftWithGemini, draftWithOpenAI, draftWithQwen]) {
      assert.deepEqual(await draft(settings, { referenceImageBase64: png }, STYLE_EXTRACTION_INSTRUCTIONS), result);
      const sent = JSON.stringify(calls.at(-1)); assert.ok(sent.includes('EXCLUDE scene layout')); assert.ok(!sent.includes('Grid layout:'));
    }
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = original; }
});
