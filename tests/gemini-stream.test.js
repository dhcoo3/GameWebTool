import test from 'node:test';
import assert from 'node:assert/strict';
import { readGeminiResponse } from '../server/geminiStream.js';
import { providerNetworkError } from '../server/network.js';
import { generateWithGemini } from '../server/index.js';
import { DEFAULT_GEMINI_MODEL } from '../src/map/geminiResolution.js';

const settings = { geminiModel: DEFAULT_GEMINI_MODEL, geminiKey: 'mock-key' };
const request = { operation: 'objects', prompt: 'extract objects', imageBase64: 'reference', width: 3840, height: 2176, resolution: '4K' };
const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ event_type: type, ...fields })}\n\n`;
const imageStream = () => event('interaction.created', { interaction: { id: 'mock-task', status: 'in_progress' } })
  + event('step.start', { index: 1, step: { type: 'model_output' } })
  + event('step.delta', { index: 1, delta: { type: 'image', data: 'aW1h', mime_type: 'image/png' } })
  + event('step.delta', { index: 1, delta: { type: 'image', data: 'Z2U=' } })
  + event('step.stop', { index: 1 })
  + event('interaction.completed', { interaction: { status: 'completed' } });
function responseStream(text, { chunkSize = 17, interrupt = false } = {}) {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize; }
    else if (interrupt) controller.error(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
    else controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
test('Gemini SSE 跨字节分块、CRLF、心跳和思考事件不污染图像，完成后拼接原始 Base64', async () => {
  const thought = event('step.start', { index: 0, step: { type: 'thought' } }) + event('step.delta', { index: 0, delta: { type: 'thought_summary', content: { text: '中文进度' } } });
  const text = (': heartbeat\n\n' + thought + imageStream()).replaceAll('\n', '\r\n');
  for (const chunkSize of [1, 17, 65536]) {
    const payload = await readGeminiResponse(responseStream(text, { chunkSize }));
    assert.deepEqual(payload.steps, [{ type: 'model_output', content: [{ type: 'image', data: 'aW1hZ2U=', mime_type: 'image/png' }] }]);
  }
  const large = 'A'.repeat(4 * 1024 * 1024);
  const payload = await readGeminiResponse(responseStream(event('step.delta', { index: 1, delta: { type: 'image', data: large } }) + 'data: [DONE]\n\n', { chunkSize: 4096 }));
  assert.equal(payload.steps[0].content[0].data, large);
});
test('Gemini JSON 返回保持兼容，完整结果、空图像和 HTTP 错误不会被伪造成图片', async () => {
  const payload = { output_image: { data: 'fixture', mime_type: 'image/jpeg' } };
  assert.deepEqual(await readGeminiResponse(Response.json(payload)), payload);
  assert.deepEqual(await readGeminiResponse(responseStream(event('interaction.completed', { interaction: { ...payload, status: 'completed' } }))), { ...payload, status: 'completed' });
  assert.deepEqual((await readGeminiResponse(responseStream(event('interaction.completed', { interaction: { status: 'completed' } })))).steps, []);
  assert.deepEqual(await readGeminiResponse(new Response('error page', { status: 502 })), {});
  await assert.rejects(readGeminiResponse(new Response('not JSON')), (e) => e.code === 'GEMINI_STREAM_INVALID');
});
test('SSE 未完成、读流断开、损坏事件或服务失败禁止返回残缺图像', async () => {
  const partial = event('step.delta', { index: 1, delta: { type: 'image', data: 'partial' } });
  await assert.rejects(readGeminiResponse(responseStream(partial)), (e) => e.code === 'GEMINI_STREAM_INCOMPLETE');
  await assert.rejects(readGeminiResponse(responseStream(partial, { interrupt: true })), (e) => e.cause?.code === 'UND_ERR_SOCKET');
  await assert.rejects(readGeminiResponse(responseStream('data: not-json\n\n')), (e) => e.code === 'GEMINI_STREAM_INVALID');
  await assert.rejects(readGeminiResponse(responseStream(event('interaction.failed', { interaction: { status: 'failed', error: { message: 'mock safety failure' } } }))), /mock safety failure/);
});
test('Gemini 只提交一次流式生成，关闭旧连接复用，4K、参考图和默认交付方式保留', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++; const body = JSON.parse(options.body);
    assert.equal(body.stream, true); assert.equal(options.headers.accept, 'text/event-stream'); assert.equal(options.headers.connection, 'close');
    assert.equal(body.input[1].data, 'reference'); assert.equal(body.response_format.image_size, '4K'); assert.equal(body.response_format.delivery, undefined);
    return responseStream(imageStream());
  };
  try { assert.deepEqual(await generateWithGemini(settings, request), { data: 'aW1hZ2U=', mimeType: 'image/png' }); assert.equal(calls, 1); }
  finally { globalThis.fetch = original; }
});
test('建立连接和读流期间的 Socket 中断都保留明确错误，不重发生成请求', async () => {
  const original = globalThis.fetch;
  try {
    for (const phase of ['connect', 'body', 'truncated']) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (phase === 'connect') throw new TypeError('fetch failed', { cause: Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }) });
        return responseStream(event('step.delta', { index: 1, delta: { type: 'image', data: 'partial' } }), { interrupt: phase === 'body' });
      };
      await assert.rejects(generateWithGemini(settings, request), (e) => e.status === 502 && /传输连接中断/.test(e.message) && /未自动重试/.test(e.message));
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = original; }
});
test('网络提示区分超时、断流和已配置代理，不暴露代理凭据；主动取消不伪报网络错误', () => {
  const env = { HTTPS_PROXY: 'http://username:private-password@proxy.test:7897' };
  const socket = providerNetworkError('Google Gemini', { cause: { code: 'UND_ERR_SOCKET' } }, { elapsedMs: 65123, env });
  assert.match(socket.message, /65\.1 秒/); assert.match(socket.message, /已配置代理/); assert.doesNotMatch(socket.message, /private-password|username|HTTP_PROXY/);
  const timeout = providerNetworkError('Google Gemini', { code: 'UND_ERR_CONNECT_TIMEOUT' }, { env: {}, elapsedMs: 10000 });
  assert.equal(timeout.status, 504); assert.match(timeout.message, /等待超时/); assert.doesNotMatch(timeout.message, /已配置代理/);
  const abort = new AbortController(); abort.abort(); assert.equal(providerNetworkError('Google Gemini', new Error(), { signal: abort.signal }), abort.signal.reason);
  const expired = new AbortController(); expired.abort(new DOMException('expired', 'TimeoutError'));
  assert.equal(providerNetworkError('Google Gemini', new Error(), { signal: expired.signal }).status, 504);
  assert.equal(providerNetworkError('Google Gemini', socket), socket);
});
