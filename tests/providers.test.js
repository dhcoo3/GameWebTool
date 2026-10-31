import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWithOpenAI, generateWithGemini, generateWithQwen, generateWithKling } from '../server/index.js';
import { validateMapRequest } from '../server/map.js';
import { newProject } from '../src/map/core.js';
import { scaleRequestContext } from '../src/map/scale.js';
import { mapGenerationPrompts } from '../src/map/prompts.js';
import { DEFAULT_GEMINI_MODEL } from '../src/map/geminiResolution.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const settings = { openaiKey: 'mock', geminiKey: 'mock', qwenKey: 'mock', klingKey: 'mock', openaiModel: 'mock-image', geminiModel: DEFAULT_GEMINI_MODEL, qwenImageModel: 'qwen-image-3.0-pro', klingModel: 'mock-image', qwenBaseUrl: 'https://qwen.example.test', klingBaseUrl: 'https://kling.example.test' };
const request = { imageBase64: png, maskBase64: png, mimeType: 'image/png', width: 128, height: 128, prompt: 'extend forest', resolution: 'native' };
test('四服务请求适配与图像解析，所有网络均为模拟响应', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    if (String(url).includes('images.example.test')) return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
    if (String(url).includes('openai.com')) return Response.json({ data: [{ b64_json: png }] });
    if (String(url).includes('googleapis.com')) return Response.json({ output_image: { data: png, mime_type: 'image/png' } });
    if (String(url).includes('qwen.example.test')) return Response.json({ output: { choices: [{ message: { content: [{ image: 'https://images.example.test/q.png' }] } }] } });
    if (String(url).endsWith('/images/generations')) return Response.json({ data: { task_id: 'mock-task' } });
    return Response.json({ data: { task_status: 'succeed', task_result: { images: [{ url: 'https://images.example.test/k.png' }] } } });
  };
  try {
    assert.equal((await generateWithOpenAI(settings, request)).data, png);
    const openai = calls.find((c) => c.url.includes('openai.com')); assert.equal(openai.body.get('mask').type, 'image/png'); assert.ok(openai.body.get('image[]')); assert.equal(openai.body.get('size'), '1024x1024');
    assert.equal((await generateWithGemini(settings, request)).data, png);
    const gemini = JSON.parse(calls.find((c) => c.url.includes('googleapis.com')).body); assert.equal(gemini.input[1].data, png); assert.equal(gemini.response_format.image_size, '1K');
    assert.equal((await generateWithQwen(settings, { ...request, resolution: '2K' })).data, png);
    const qwen = JSON.parse(calls.find((c) => c.url.includes('qwen.example.test')).body); assert.equal(qwen.parameters.size, '2048*2048');
    const klingRequest = validateMapRequest({ ...request, provider: 'kling', operation: 'seed', negativePrompt: '人物', resolution: '1K' });
    assert.equal((await generateWithKling(settings, klingRequest)).data, png);
    const kling = JSON.parse(calls.find((c) => c.url.endsWith('/images/generations')).body); assert.equal(kling.resolution, '1k'); assert.equal(kling.image, png);
    assert.match(kling.prompt, /ALL FOUR CORNERS/); assert.match(kling.prompt, /camera angle ONLY/); assert.match(kling.prompt, /diamond-shaped map outline/); assert.match(kling.prompt, /人物/);
  } finally { globalThis.fetch = original; }
});
test('服务失败返回错误而不是伪造成功图像', async () => {
  const original = globalThis.fetch; globalThis.fetch = async () => Response.json({ error: { message: 'simulated failure' } }, { status: 429 });
  try { await assert.rejects(generateWithOpenAI(settings, request), /simulated failure/); await assert.rejects(generateWithGemini(settings, request), /simulated failure/); }
  finally { globalThis.fetch = original; }
});
test('Gemini 请求 JPEG 输出，保留参考图格式并按响应 MIME 解码，不追加生成请求', async () => {
  const original = globalThis.fetch, calls = [];
  const jpeg = '/9j/fixture';
  const responses = [
    { output_image: { data: jpeg, mime_type: 'image/jpeg' } },
    { steps: [{ type: 'model_output', content: [{ type: 'image', data: jpeg }] }] },
    { output_image: { data: png, mime_type: 'image/png' } },
  ];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    assert.equal(body.response_format.mime_type, 'image/jpeg');
    assert.ok(!Object.hasOwn(body.response_format, 'delivery'));
    return Response.json(responses[calls.length - 1]);
  };
  try {
    for (let i = 0; i < responses.length; i++) {
      const image = await generateWithGemini(settings, { ...request, resolution: '2K', width: 3840, height: 2176 });
      assert.deepEqual(image, i === 2 ? { data: png, mimeType: 'image/png' } : { data: jpeg, mimeType: 'image/jpeg' });
      assert.equal(calls.length, i + 1);
      assert.equal(calls[i].input[1].mime_type, 'image/png');
      assert.equal(calls[i].input[1].data, png);
      assert.equal(calls[i].response_format.image_size, '2K');
      assert.equal(calls[i].response_format.aspect_ratio, '16:9');
    }
  } finally { globalThis.fetch = original; }
});
test('Gemini 物件/地面及其他生图使用默认交付方式，兼容拒绝显式 delivery 的服务且不追加请求', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (Object.hasOwn(body.response_format, 'delivery')) return Response.json({ error: { message: 'Image delivery mode is not supported.' } }, { status: 400 });
    return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'image', data: png, mime_type: 'image/png' }] }] });
  };
  try {
    for (const operation of ['objects', 'ground', 'seed', 'expand', 'retouch', 'matte']) {
      const body = validateMapRequest({ ...request, provider: 'gemini', operation, resolution: '2K' }, settings);
      const before = calls.length, image = await generateWithGemini(settings, body);
      assert.equal(calls.length, before + 1); assert.equal(image.data, png); assert.equal(image.mimeType, 'image/png');
      const sent = calls.at(-1); assert.equal(sent.response_format.mime_type, 'image/jpeg'); assert.equal(sent.response_format.image_size, '2K');
      assert.ok(!Object.hasOwn(sent.response_format, 'delivery')); assert.equal(sent.input[1].data, png);
      if (operation === 'objects') assert.match(sent.input[0].text, /#FF00FF/);
    }
    globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ error: { message: 'Image delivery mode is not supported.' } }, { status: 400 }); };
    const before = calls.length;
    await assert.rejects(generateWithGemini(settings, { ...request, operation: 'objects' }), /Image delivery mode is not supported/);
    assert.equal(calls.length, before + 1, '服务报错后自动重试了付费生成');
  } finally { globalThis.fetch = original; }
});
test('可灵实际请求体：开启比例后的长中文描述与反向词完整保留，初始图/扩图/重绘低于 2500', async () => {
  const original = globalThis.fetch, calls = [];
  // Stop at the mocked create-task boundary: no poll or billable request occurs.
  globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ error: { message: 'MOCK_SUBMISSION' } }, { status: 429 }); };
  try {
    const p = { ...newProject(), grid: { ...newProject().grid, layout: 'isometric' }, scaleReference: { enabled: true, environmentRulesEnabled: true, heightPx: 62, doorHeightPx: 90 } };
    const scaleReference = scaleRequestContext(p, 3840, 2176);
    const description = '暗黑幻想村庄游戏地图。采用45°等距斜视、正交投影，所有建筑道路和环境物件遵循同一视角、朝向与透视比例。' + '完整住宅、旅店、作坊、小礼拜堂、仓库、围栏、路灯、木桶，大小适合人物穿行，树木分布自然。'.repeat(14) + '保留描述末尾标记';
    const negative = '透视混乱，多个不一致的观察角度，建筑朝向混乱，文字，水印，人物，路面断裂，反向词末尾标记';
    for (const operation of ['seed', 'expand', 'retouch']) for (const reference of [true, false]) {
      if (operation !== 'seed' && !reference) continue;
      const normalized = mapGenerationPrompts(operation, description, negative, scaleReference);
      const body = validateMapRequest({ ...request, provider: 'kling', operation, scaleReference, ...normalized, imageBase64: reference ? png : '', markedGuide: operation !== 'seed' });
      if (operation === 'expand') assert.ok(body.prompt.length + body.negativePrompt.length > 2500, '回归样例未重现原超长条件');
      await assert.rejects(generateWithKling(settings, body), /MOCK_SUBMISSION/);
      const sent = calls.at(-1); assert.ok(sent.prompt.length <= 2500, `最终请求超过限制: ${sent.prompt.length}`);
      assert.ok(sent.prompt.includes(description), '用户描述被截断'); assert.ok((sent.prompt + (sent.negative_prompt || '')).includes('反向词末尾标记'), '反向提示词被截断');
      assert.match(sent.prompt, /2\.849%h/); assert.match(sent.prompt, /door openings: 4\.136%–4\.136%h/);
      assert.match(sent.prompt, /Paths clear width/); assert.match(sent.prompt, /small house footprint 4x3/); assert.match(sent.prompt, /trees/); assert.match(sent.prompt, /No characters/);
      if (operation !== 'seed') { assert.match(sent.prompt, /ONLY/); assert.match(sent.prompt, /MAGENTA/); }
      if (operation === 'seed' || operation === 'expand') assert.match(sent.prompt, /ALL FOUR CORNERS/);
    }
  } finally { globalThis.fetch = original; }
});
test('可灵 2500 边界和超长本地拦截，不静默截断，不创建远端任务', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { message: 'MOCK_SUBMISSION' } }, { status: 429 }); };
  try {
    await assert.rejects(generateWithKling(settings, { ...request, imageBase64: '', prompt: 'a'.repeat(2500) }), /MOCK_SUBMISSION/); assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(generateWithKling(settings, { ...request, prompt: 'a'.repeat(2501) }), (error) => error.status === 400 && /再缩短至少 1 个字符/.test(error.message));
    await assert.rejects(generateWithKling(settings, { ...request, prompt: 'a'.repeat(2480), negativePrompt: '不得改变地形、视角和比例。'.repeat(10) }), /请求尚未提交/);
    await assert.rejects(generateWithKling(settings, { ...request, imageBase64: '', negativePrompt: '反'.repeat(2501) }), /反向提示词/);
    assert.equal(calls, 0, '超长请求仍调用了远端服务');
  } finally { globalThis.fetch = original; }
});
test('独立分层请求使用原图编辑、真实透明 PNG 参数，不带入场景描述和反向词', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push(options.body); return Response.json({ data: [{ b64_json: png }] }); };
  try {
    for (const operation of ['objects', 'ground', 'matte']) {
      const body = validateMapRequest({ ...request, width: 3840, height: 2176, provider: 'openai', operation, prompt: 'SCENE_MUST_NOT_LEAK: generate a village with houses', negativePrompt: 'NEGATIVE_MUST_NOT_LEAK: white objects' });
      assert.ok(!body.prompt.includes('SCENE_MUST_NOT_LEAK') && !body.prompt.includes('MAP_SCALE_REFERENCE')); assert.equal(body.negativePrompt, '');
      assert.equal((await generateWithOpenAI({ ...settings, openaiModel: 'gpt-image-2.5-sunburst' }, body)).data, png);
      const form = calls.at(-1); assert.equal(form.get('output_format'), 'png'); assert.equal(form.get('background'), operation === 'objects' ? 'transparent' : 'opaque'); assert.equal(form.get('size'), '1536x864');
      assert.ok(form.get('image[]')); assert.ok(!form.get('prompt').includes('NEGATIVE_MUST_NOT_LEAK'));
      if (operation === 'objects') { assert.match(form.get('prompt'), /TRUE alpha transparency/); assert.match(form.get('prompt'), /fence posts and foliage/); }
      if (operation === 'ground') { assert.match(form.get('prompt'), /KEEP flat terrain/); assert.match(form.get('prompt'), /Remove EVERY standing object/); }
    }
    assert.throws(() => validateMapRequest({ ...request, provider: 'qwen', operation: 'objects' }), /不支持物件层生成/);
    assert.match(validateMapRequest({ ...request, provider: 'gemini', operation: 'objects' }).prompt, /#FF00FF/);
    const custom = validateMapRequest({ ...request, provider: 'openai', operation: 'ground', layerPrompt: 'CUSTOM_GROUND_ONLY' }); assert.equal(custom.prompt, 'CUSTOM_GROUND_ONLY');
    const marked = validateMapRequest({ ...request, provider: 'kling', operation: 'ground', markedGuide: true }); assert.match(marked.prompt, /Remove ALL magenta coloring/);
  } finally { globalThis.fetch = original; }
});
test('可灵地面补绘不重新引入建造村庄描述', async () => {
  const original = globalThis.fetch; let sent;
  globalThis.fetch = async (url, options) => { sent = JSON.parse(options.body); return Response.json({ error: { message: 'MOCK_ONLY' } }, { status: 429 }); };
  try {
    const body = validateMapRequest({ ...request, provider: 'kling', operation: 'ground', prompt: 'SCENE_BUILD_HOUSES', negativePrompt: 'SCENE_NEGATIVE' });
    await assert.rejects(generateWithKling(settings, body), /MOCK_ONLY/);
    assert.ok(!sent.prompt.includes('SCENE_BUILD_HOUSES') && !sent.prompt.includes('SCENE_NEGATIVE')); assert.match(sent.prompt, /Ground layer ONLY/); assert.ok(sent.prompt.length < 2500);
  } finally { globalThis.fetch = original; }
});
test('可灵物件提取使用独立 Omni 模型与创建/查询路径，复用密钥端点且只生成一张', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    if (String(url).includes('images.example.test')) return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
    if (options.method === 'POST') return Response.json({ code: 0, data: { task_id: 'object/task' } });
    return Response.json({ code: 0, data: { task_status: 'succeed', task_result: { images: [{ url: 'https://images.example.test/objects.png' }] } } });
  };
  try {
    const body = validateMapRequest({ ...request, provider: 'kling', operation: 'objects', width: 768, height: 432, resolution: '1K', prompt: 'FORBIDDEN_SCENE' });
    assert.equal((await generateWithKling(settings, body)).data, png);
    const posts = calls.filter((call) => call.method === 'POST'); assert.equal(posts.length, 1); assert.equal(posts[0].url, 'https://kling.example.test/v1/images/omni-image'); assert.equal(posts[0].headers.authorization, 'Bearer mock');
    const sent = JSON.parse(posts[0].body); assert.equal(sent.model_name, 'kling-v3-omni'); assert.equal(settings.klingModel, 'mock-image');
    assert.deepEqual(sent.image_list, [{ image: png }]); assert.equal(sent.image, undefined); assert.equal(sent.n, 1); assert.equal(sent.result_type, 'single'); assert.equal(sent.aspect_ratio, 'auto'); assert.equal(sent.resolution, '1k'); assert.equal(sent.background, undefined);
    assert.ok(sent.prompt.includes('<<<image_1>>>') && sent.prompt.includes('TRUE alpha transparency') && !sent.prompt.includes('FORBIDDEN_SCENE')); assert.ok(sent.prompt.length < 2500);
    assert.ok(calls.some((call) => call.url === 'https://kling.example.test/v1/images/omni-image/object%2Ftask'));
    assert.ok(!calls.some((call) => call.url.includes('/images/generations')));
  } finally { globalThis.fetch = original; }
});
test('可灵 Omni 错误和非法参考图均不自动重试或回退到标准生图', async () => {
  const original = globalThis.fetch; let calls = 0;
  const body = validateMapRequest({ ...request, provider: 'kling', operation: 'objects', width: 768, height: 432 });
  globalThis.fetch = async () => { calls++; return Response.json({ code: 1001, message: 'Omni permission denied' }); };
  try {
    await assert.rejects(generateWithKling(settings, body), /Omni permission denied/); assert.equal(calls, 1);
    calls = 0;
    for (const patch of [{ imageBase64: '' }, { width: 200 }, { width: 2000, height: 300 }, { imageBase64: 'a'.repeat(14 * 1024 * 1024) }]) await assert.rejects(generateWithKling(settings, { ...body, ...patch }), (error) => error.status === 400);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('四服务实际请求保留全局规则一次，可灵全局规则超长在提交前拒绝', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    if (String(url).includes('images.example.test')) return new Response(Buffer.from(png, 'base64'));
    if (String(url).includes('openai.com')) return Response.json({ data: [{ b64_json: png }] });
    if (String(url).includes('googleapis.com')) return Response.json({ output_image: { data: png, mime_type: 'image/png' } });
    if (String(url).includes('qwen.example.test')) return Response.json({ output: { choices: [{ message: { content: [{ image: 'https://images.example.test/q.png' }] } }] } });
    if (String(url).endsWith('/images/generations')) return Response.json({ data: { task_id: 'mock-task' } });
    return Response.json({ data: { task_status: 'succeed', task_result: { images: [{ url: 'https://images.example.test/k.png' }] } } });
  };
  try {
    const generators = { openai: generateWithOpenAI, gemini: generateWithGemini, qwen: generateWithQwen, kling: generateWithKling };
    for (const [provider, generate] of Object.entries(generators)) {
      calls.length = 0;
      await generate(settings, validateMapRequest({ ...request, provider, operation: 'seed', globalPositivePrompt: 'GLOBAL_STYLE_SENTINEL', globalNegativePrompt: 'GLOBAL_AVOID_SENTINEL', scaleReference: scaleRequestContext(newProject(), 1280, 720) }));
      const sent = calls[0].body;
      const content = typeof sent === 'string' ? sent : String(sent.get('prompt'));
      assert.match(content, /mature trees/); assert.match(content, /huts/); assert.match(content, /Only size objects that actually appear/);
      assert.equal(content.split('GLOBAL_STYLE_SENTINEL').length - 1, 1);
      assert.equal(content.split('GLOBAL_AVOID_SENTINEL').length - 1, 1);
    }
    for (const key of ['globalPositivePrompt', 'globalNegativePrompt']) {
      calls.length = 0;
      const body = validateMapRequest({ ...request, provider: 'kling', operation: 'seed', [key]: '全局规则'.repeat(1000) + 'TAIL_SENTINEL' });
      assert.ok((body.prompt + body.negativePrompt).includes('TAIL_SENTINEL'));
      await assert.rejects(generateWithKling(settings, body), /内容未截断/);
      assert.equal(calls.length, 0);
    }
  } finally { globalThis.fetch = original; }
});
