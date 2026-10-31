import { STYLE_EXTRACTION_INSTRUCTIONS } from '../src/map/reference.js';
import { composeTilePrompt, providerPrompts, mapDiagnostics } from './providerPrompts.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MAP_CAPABILITIES, validateMapRequest } from './map.js';
import { assertKlingPromptLength, klingMapPrompts } from './klingPrompt.js';
import { KLING_OBJECT_MODEL } from '../src/map/layerCapabilities.js';
import { geminiGroundResolutions, geminiResolutions, validateGeminiResolution, resolveGeminiGround, MAP_REQUEST_LIMIT } from '../src/map/geminiResolution.js';
import { providerNetworkError } from './network.js';
import { readGeminiResponse } from './geminiStream.js';

const mapRequestContext = new AsyncLocalStorage();
const mapSubmissionContext = new AsyncLocalStorage();

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const settingsPath = path.join(appRoot, '.local-settings.json');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4179);
const defaultSettings = {
  openaiKey: '',
  geminiKey: '',
  qwenKey: '',
  klingKey: '',
  openaiModel: 'gpt-image-2.5-sunburst',
  geminiModel: 'gemini-nano-banana-2.1',
  openaiPromptModel: 'gpt-5.4-mini',
  geminiPromptModel: 'gemini-3.8-flash',
  qwenBaseUrl: 'https://dashscope.aliyuncs.com',
  qwenImageModel: 'qwen-image-3.0-pro',
  qwenPromptModel: 'qwen3.8-max',
  klingBaseUrl: 'https://api-beijing.klingai.com',
  klingModel: 'kling-v3',
};

async function readSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(await fs.readFile(settingsPath, 'utf8')) };
  } catch {
    return { ...defaultSettings };
  }
}

async function saveSettings(settings) {
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  try { await fs.chmod(settingsPath, 0o600); } catch { /* platform may not support POSIX modes */ }
}

function json(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

async function readBody(request, limit = MAP_REQUEST_LIMIT) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) throw Object.assign(new Error('上传内容过大，请先缩小底图后再试。'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function providerMessage(payload, fallback) {
  return payload?.error?.message || payload?.message || payload?.error || fallback;
}

function providerBaseUrl(value, providerName) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { throw Object.assign(new Error(`${providerName} API 地址无效，请在服务设置中检查端点。`), { status: 400 }); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error(`${providerName} API 地址必须是有效的 HTTPS 域名。`), { status: 400 });
  }
  return parsed.toString().replace(/\/$/, '').replace(/\/(api\/v1|compatible-mode\/v1)$/i, '');
}

function qwenProviderUrl(settings, suffix) {
  return `${providerBaseUrl(settings.qwenBaseUrl, '千问')}${suffix}`;
}

function klingProviderUrl(settings, suffix) {
  return `${providerBaseUrl(settings.klingBaseUrl, '可灵')}${suffix}`;
}

function decodeDataUrl(base64, mimeType = 'image/png') {
  return `data:${mimeType};base64,${base64}`;
}

async function fetchImageAsBase64(url, providerName) {
  let target;
  try { target = new URL(url); } catch { throw new Error(`${providerName} 返回了无法识别的图像地址。`); }
  if (target.protocol !== 'https:') throw new Error(`${providerName} 返回的图像地址不是安全的 HTTPS 地址。`);
  const response = await fetchProvider(target, {}, `${providerName} 图像下载`);
  if (!response.ok) throw Object.assign(new Error(`${providerName} 图像下载失败（${response.status}）。`), { status: response.status });
  const contentType = response.headers.get('content-type')?.split(';')[0].trim() || 'image/png';
  if (!contentType.startsWith('image/')) throw new Error(`${providerName} 返回的文件不是图像。`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 24 * 1024 * 1024) throw new Error(`${providerName} 返回的图像为空或超过 24 MB。`);
  return { data: bytes.toString('base64'), mimeType: contentType };
}

function qwenImageSize(width, height) {
  const ratio = width / height;
  if (ratio > 8 || ratio < 1 / 8) throw Object.assign(new Error('千问图片比例需在 1:8 到 8:1 之间，请调整区域形状或 Cell 像素尺寸。'), { status: 400 });
  const maxArea = 2048 * 2048;
  const minArea = 512 * 512;
  const scale = Math.min(2048 / width, 2048 / height, Math.sqrt(maxArea / (width * height)), Math.max(1, Math.sqrt(minArea / (width * height))));
  return `${Math.max(1, Math.round(width * scale))}*${Math.max(1, Math.round(height * scale))}`;
}

function klingAspectRatio(width, height) {
  const options = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'];
  const targetRatio = width / height;
  if (targetRatio > 21 / 9 + .01 || targetRatio < 9 / 16 - .01) {
    throw Object.assign(new Error('可灵图像比例支持范围为 9:16 到 21:9；此区域比例过长，请调整区域或改用千问生成。'), { status: 400 });
  }
  return options.reduce((best, value) => {
    const [w, h] = value.split(':').map(Number);
    const ratio = w / h;
    return Math.abs(Math.log(width / height / ratio)) < Math.abs(Math.log(width / height / best.ratio)) ? { value, ratio } : best;
  }, { value: '1:1', ratio: 1 }).value;
}

async function fetchJson(response, providerName) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(providerMessage(payload, `${providerName} API 请求失败（${response.status}）`)), { status: response.status });
  return payload;
}

async function fetchProvider(url, options, providerName) {
  const started = Date.now(), signal = mapRequestContext.getStore() || options.signal;
  try {
    const submission = mapSubmissionContext.getStore(), isSubmission = options.method === 'POST';
    if (submission && isSubmission) submission.submitted = null;
    const response = await fetch(url, { ...options, ...(signal ? { signal } : {}) });
    if (submission && isSubmission) submission.submitted = true;
    return response;
  } catch (cause) {
    throw providerNetworkError(providerName, cause, { elapsedMs: Date.now() - started, signal });
  }
}

function aspectRatioName(width, height) {
  const ratios = [
    ['1:1', 1], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9],
    ['5:4', 5 / 4], ['4:5', 4 / 5], ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16], ['21:9', 21 / 9],
  ];
  const ratio = width / height;
  return ratios.reduce((closest, item) => Math.abs(item[1] - ratio) < Math.abs(closest[1] - ratio) ? item : closest)[0];
}

// Interactions image output supports JPEG; reference inputs may still be PNG.
const GEMINI_OUTPUT_MIME = 'image/jpeg';

function outputImageFromGemini(payload) {
  if (payload?.output_image?.data) {
    return { data: payload.output_image.data, mimeType: payload.output_image.mime_type || GEMINI_OUTPUT_MIME };
  }
  for (const step of payload?.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) {
      if (block.type === 'image' && block.data) {
        return { data: block.data, mimeType: block.mime_type || GEMINI_OUTPUT_MIME };
      }
    }
  }
  return null;
}

async function generateWithGemini(settings, requestData) {
  const started = Date.now();
  const prompt = providerPrompts(settings, { ...requestData, provider: 'gemini' }).prompt;
  const ground = requestData.operation === 'ground' ? resolveGeminiGround(settings.geminiModel, requestData.resolution, requestData.width, requestData.height) : null;
  const ratio = ground?.aspectRatio || aspectRatioName(requestData.width, requestData.height);
  const selectedSize = ground ? null : validateGeminiResolution(settings.geminiModel, requestData.resolution);
  const imageSize = ground ? ground.resolvedResolution : selectedSize === 'native' ? geminiResolutions(settings.geminiModel).includes('1K') ? '1K' : 'native' : selectedSize;
  const input = [{ type: 'text', text: prompt }];
  if (requestData.imageBase64) input.push({ type: 'image', mime_type: requestData.mimeType || 'image/png', data: requestData.imageBase64 });
  const response = await fetchProvider('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', connection: 'close', 'x-goog-api-key': settings.geminiKey },
    body: JSON.stringify({
      model: settings.geminiModel,
      input,
      stream: true,
      // Let the service use its default image delivery. Explicit `inline` is
      // rejected by some image-model deployments even though the field is optional.
      response_format: { type: 'image', mime_type: GEMINI_OUTPUT_MIME, aspect_ratio: ratio, ...(imageSize === 'native' ? {} : { image_size: imageSize }) },
    }),
  }, 'Google Gemini');
  let payload;
  try { payload = await readGeminiResponse(response); }
  catch (cause) {
    if (cause.providerResponse || ['GEMINI_STREAM_INVALID', 'GEMINI_STREAM_LIMIT'].includes(cause.code)) throw cause;
    throw providerNetworkError('Google Gemini', cause, { elapsedMs: Date.now() - started, signal: mapRequestContext.getStore() });
  }
  if (!response.ok) {
    throw Object.assign(new Error(providerMessage(payload, `Google API 请求失败（${response.status}）`)), { status: response.status });
  }
  const image = outputImageFromGemini(payload);
  if (!image) throw new Error('Google 已返回响应，但没有找到生成的图像。请确认模型支持图像输出。');
  return ground ? { ...image, generation: { ...ground, model: settings.geminiModel } } : image;
}

async function generateWithOpenAI(settings, requestData) {
  const prompt = providerPrompts(settings, { ...requestData, provider: 'openai' }).prompt;
  const layerEdit = ['objects', 'ground', 'matte'].includes(requestData.operation);
  const modernImage = /^gpt-image-(2|2\.5)/.test(settings.openaiModel);
  const ratio = requestData.width / requestData.height, factor = 1536 / Math.max(requestData.width, requestData.height);
  const size = layerEdit && modernImage && ratio >= 1 / 3 && ratio <= 3
    ? `${Math.max(16, Math.round(requestData.width * factor / 16) * 16)}x${Math.max(16, Math.round(requestData.height * factor / 16) * 16)}`
    : requestData.width === requestData.height ? '1024x1024' : requestData.width > requestData.height ? '1536x1024' : '1024x1536';
  let response;
  if (requestData.imageBase64) {
    const form = new FormData();
    const imageBuffer = Buffer.from(requestData.imageBase64, 'base64');
    const imageBlob = new Blob([imageBuffer], { type: requestData.mimeType || 'image/png' });
    form.append('model', settings.openaiModel);
    form.append('prompt', prompt);
    form.append('image[]', imageBlob, 'scene-reference.png');
    if (requestData.maskBase64) {
      const maskBuffer = Buffer.from(requestData.maskBase64, 'base64');
      form.append('mask', new Blob([maskBuffer], { type: 'image/png' }), 'scene-selection-mask.png');
    }
    form.append('size', size);
    form.append('quality', 'high');
    if (layerEdit) { form.append('background', requestData.operation === 'objects' ? 'transparent' : 'opaque'); form.append('output_format', 'png'); }
    response = await fetchProvider('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.openaiKey}` },
      body: form,
    }, 'OpenAI');
  } else {
    response = await fetchProvider('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.openaiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.openaiModel, prompt, size, quality: 'high' }),
    }, 'OpenAI');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(providerMessage(payload, `OpenAI API 请求失败（${response.status}）`)), { status: response.status });
  }
  const encoded = payload?.data?.[0]?.b64_json;
  if (!encoded) throw new Error('OpenAI 已返回响应，但没有找到生成的图像。');
  return { data: encoded, mimeType: 'image/png' };
}

async function generateWithQwen(settings, requestData) {
  const finalPrompts = providerPrompts(settings, { ...requestData, provider: 'qwen' }), negativePrompt = finalPrompts.negativePrompt;
  const model = settings.qwenImageModel;
  const content = [];
  if (requestData.imageBase64) content.push({ image: decodeDataUrl(requestData.imageBase64, requestData.mimeType || 'image/png') });
  content.push({ text: finalPrompts.prompt });
  const response = await fetchProvider(qwenProviderUrl(settings, '/api/v1/services/aigc/multimodal-generation/generation'), {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.qwenKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: { messages: [{ role: 'user', content }] },
      parameters: {
        size: qwenImageSize(Number(requestData.width) * (requestData.resolution === '1K' ? 1024 / Math.max(requestData.width, requestData.height) : requestData.resolution === '2K' ? 2048 / Math.max(requestData.width, requestData.height) : 1), Number(requestData.height) * (requestData.resolution === '1K' ? 1024 / Math.max(requestData.width, requestData.height) : requestData.resolution === '2K' ? 2048 / Math.max(requestData.width, requestData.height) : 1)),
        prompt_extend: true,
        watermark: false,
        ...(negativePrompt && model.includes('3.0') ? { negative_prompt: negativePrompt } : {}),
      },
    }),
  }, '阿里云百炼千问');
  const payload = await fetchJson(response, '阿里云百炼千问');
  const imageUrl = payload?.output?.choices?.[0]?.message?.content?.find?.((item) => item.image)?.image
    || payload?.output?.choices?.[0]?.message?.content?.[0]?.image;
  if (!imageUrl) throw new Error(payload?.message || '千问已返回响应，但没有找到生成的图像。');
  return fetchImageAsBase64(imageUrl, '千问');
}

async function generateWithKling(settings, requestData) {
  const reference = requestData.imageBase64 || '';
  const extractingObjects = requestData.operation === 'objects';
  const taskPath = extractingObjects ? '/v1/images/omni-image' : '/v1/images/generations';
  if (extractingObjects) {
    const ratio = Number(requestData.width) / Number(requestData.height);
    if (!reference) throw Object.assign(new Error('可灵物件提取需要原图。'), { status: 400 });
    if (!Number.isFinite(ratio) || ratio < 1 / 2.5 || ratio > 2.5 || Number(requestData.width) < 300 || Number(requestData.height) < 300) throw Object.assign(new Error('可灵 Omni 参考图宽高至少 300 px，宽高比需要在 1:2.5 到 2.5:1 之间。'), { status: 400 });
    if (Buffer.from(reference, 'base64').length > 10 * 1024 * 1024) throw Object.assign(new Error('可灵 Omni 参考图不能超过 10 MB，请先缩小底图。'), { status: 400 });
  }
  const prompts = providerPrompts(settings, { ...requestData, provider: 'kling' });
  const prompt = prompts.prompt, negativePrompt = prompts.negativePrompt;
  assertKlingPromptLength(prompt);
  assertKlingPromptLength(negativePrompt, '反向提示词');
  const requestBody = {
    model_name: extractingObjects ? KLING_OBJECT_MODEL : settings.klingModel,
    prompt,
    n: 1,
    aspect_ratio: extractingObjects ? 'auto' : klingAspectRatio(Number(requestData.width), Number(requestData.height)),
    resolution: requestData.resolution === '1K' ? '1k' : requestData.resolution === '2K' ? '2k' : Math.max(Number(requestData.width), Number(requestData.height)) > 1024 ? '2k' : '1k',
    watermark_info: { enabled: false },
  };
  if (extractingObjects) {
    requestBody.image_list = [{ image: reference }]; requestBody.result_type = 'single';
  } else if (reference) {
    requestBody.image = reference;
  } else if (negativePrompt) {
    requestBody.negative_prompt = negativePrompt;
  }

  const headers = { authorization: `Bearer ${settings.klingKey}`, 'content-type': 'application/json' };
  const createdResponse = await fetchProvider(klingProviderUrl(settings, taskPath), {
    method: 'POST', headers, body: JSON.stringify(requestBody),
  }, '可灵');
  const created = await fetchJson(createdResponse, '可灵');
  if (created.code != null && Number(created.code) !== 0) throw new Error(created.message || '可灵创建任务失败。');
  const taskId = created?.data?.task_id;
  if (!taskId) throw new Error(created?.message || '可灵没有返回图像生成任务编号。');

  let task;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (mapRequestContext.getStore()?.aborted) throw new Error('地图生成已停止。');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pollResponse = await fetchProvider(klingProviderUrl(settings, `${taskPath}/${encodeURIComponent(taskId)}`), { headers }, '可灵');
    task = await fetchJson(pollResponse, '可灵');
    if (task.code != null && Number(task.code) !== 0) throw new Error(task.message || '可灵查询任务失败。');
    const status = String(task?.data?.task_status || '').toLowerCase();
    if (status === 'succeed' || status === 'success') break;
    if (status === 'failed' || status === 'failure') {
      throw new Error(task?.data?.task_status_msg || task?.message || '可灵图像生成失败。');
    }
  }
  if (!task || !['succeed', 'success'].includes(String(task.data?.task_status || '').toLowerCase())) {
    throw Object.assign(new Error('可灵生成任务等待超时，请稍后重试。'), { status: 504 });
  }
  const imageUrl = task?.data?.task_result?.images?.[0]?.url;
  if (!imageUrl) throw new Error('可灵任务已完成，但没有找到生成的图像。');
  return fetchImageAsBase64(imageUrl, '可灵');
}


const PROMPT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    negativePrompt: { type: 'string' },
  },
  required: ['prompt', 'negativePrompt'],
  additionalProperties: false,
};
const GEMINI_PROMPT_SCHEMA = {
  type: 'OBJECT',
  properties: { prompt: { type: 'STRING' }, negativePrompt: { type: 'STRING' } },
  required: ['prompt', 'negativePrompt'],
};

function scenePromptInstructions(body) {
  const layoutLabels = { rectangle: 'Rectangular', isometric: 'Isometric', isometricZAsY: 'Isometric Z as Y', hexagon: `${body.hexOrientation === 'flat' ? 'Hexagonal Flat Top' : 'Hexagonal Point Top'}` };
  const name = String(body.name || 'Scene region').slice(0, 100);
  const description = String(body.description || '').slice(0, 4000);
  const cellCount = Math.max(1, Number(body.cellCount) || 1);
  const width = Math.max(1, Math.round(Number(body.width) || 100));
  const height = Math.max(1, Math.round(Number(body.height) || 100));
  const layer = Math.max(0, Math.min(9, Number(body.layer) || 0));
  const globalDescription = String(body.globalDescription || '').trim().slice(0, 4000);
  const globalPositivePrompt = String(body.globalPositivePrompt || '').trim().slice(0, 4000);
  const globalNegativePrompt = String(body.globalNegativePrompt || '').trim().slice(0, 4000);
  const lowerLayerReference = body.referenceKind === 'lower-layers' && body.referenceImageBase64
    ? 'A reference image is included: it is a crop of this scene rendered from the visible lower layers. Treat it as the exact ground and environment for this region. Match its terrain materials, palette, lighting, perspective, texture scale, and game art style. Describe the requested upper-layer object as belonging on this ground (for example, a road should follow and blend with the existing terrain). Do not replace or redesign the ground.'
    : '';
  return `Create concise image-generation prompts for one coherent game scene region. Return only a JSON object with keys "prompt" and "negativePrompt".\nRegion name: ${name}.\nGrid layout: ${layoutLabels[body.layout] || 'Rectangular'}.\nTarget image bounds: ${width} by ${height} pixels covering ${cellCount} selected grid cells.\nDraw order layer: ${layer} (layer is only a compositing order, not a content category).\nGlobal description and context: ${globalDescription || 'No extra project context.'}\nGlobal positive prompt (must be followed in the positive prompt for every region): ${globalPositivePrompt || 'No global positive prompt.'}\nGlobal negative prompt (must be included in the negative prompt for every region): ${globalNegativePrompt || 'No global negative prompt.'}\nUser description for this region: ${description || 'No extra description.'}\n${lowerLayerReference}\nThe positive prompt should describe all visual content and spatial arrangement across one connected scene area, suitable for a game background or map region, with a coherent viewing angle and style. Follow the global description and global positive prompt for game genre, art style, pixel scale, character proportions, palette, camera, and lighting; the regional description only specifies this area and must not contradict the global rules. The negative prompt should preserve the global negative prompt and list any additional qualities to avoid, such as text, UI, frames, unrelated subjects, unwanted isolated empty spaces, or inconsistent perspective. Do not put negative constraints into the positive prompt. Avoid describing a single isolated tile or repeating stamp. Keep the subject within the requested area and make the composition work with the selected grid shape. If a user-provided reference image is included, preserve its visual style and useful palette while creating the requested region. Keep both prompts practical and editable.`;
}

function appendGlobalPrompts(prompt, negativePrompt, globalDescription, globalPositivePrompt, globalNegativePrompt) {
  const description = String(globalDescription || '').trim().slice(0, 4000);
  const positive = String(globalPositivePrompt || '').trim().slice(0, 4000);
  const negativeRules = String(globalNegativePrompt || '').trim().slice(0, 4000);
  const positiveRules = [
    description && `Global description and art direction (must follow): ${description}`,
    positive && `Global positive prompt (must follow): ${positive}`,
  ].filter(Boolean);
  return {
    prompt: [String(prompt || '').trim(), ...positiveRules].filter(Boolean).join('\n\n'),
    negativePrompt: [String(negativePrompt || '').trim(), negativeRules ? `Global negative prompt (must avoid): ${negativeRules}` : ''].filter(Boolean).join('\n\n'),
  };
}

function parsePromptResult(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(cleaned);
  if (typeof value.prompt !== 'string' || typeof value.negativePrompt !== 'string') throw new Error('提示词模型返回内容格式不正确。');
  return { prompt: value.prompt.trim(), negativePrompt: value.negativePrompt.trim() };
}

function getOpenAIOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return '';
}

async function draftWithOpenAI(settings, body, instructions = scenePromptInstructions(body)) {
  const content = [{ type: 'input_text', text: instructions }];
  if (body.referenceImageBase64) {
    content.push({ type: 'input_image', image_url: `data:${body.referenceMimeType || 'image/png'};base64,${body.referenceImageBase64}`, detail: 'high' });
  }
  const response = await fetchProvider('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: settings.openaiPromptModel,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'scene_region_prompts', strict: true, schema: PROMPT_SCHEMA } },
    }),
  }, 'OpenAI');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(providerMessage(payload, `OpenAI API 请求失败（${response.status}）`)), { status: response.status });
  const output = getOpenAIOutputText(payload);
  if (!output) throw new Error('OpenAI 已返回响应，但没有找到提示词。');
  return parsePromptResult(output);
}

async function draftWithGemini(settings, body, instructions = scenePromptInstructions(body)) {
  const parts = [{ text: instructions }];
  if (body.referenceImageBase64) parts.push({ inline_data: { mime_type: body.referenceMimeType || 'image/png', data: body.referenceImageBase64 } });
  const response = await fetchProvider(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiPromptModel)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.geminiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_PROMPT_SCHEMA },
    }),
  }, 'Google Gemini');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(providerMessage(payload, `Google API 请求失败（${response.status}）`)), { status: response.status });
  const output = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  if (!output) throw new Error('Google 已返回响应，但没有找到提示词。');
  return parsePromptResult(output);
}

async function draftWithQwen(settings, body, instructions = scenePromptInstructions(body)) {
  const content = [{ type: 'text', text: instructions }];
  if (body.referenceImageBase64) {
    content.push({
      type: 'image_url',
      image_url: { url: decodeDataUrl(body.referenceImageBase64, body.referenceMimeType || 'image/png') },
    });
  }
  const response = await fetchProvider(qwenProviderUrl(settings, '/compatible-mode/v1/chat/completions'), {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.qwenKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: settings.qwenPromptModel,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
    }),
  }, '阿里云百炼千问');
  const payload = await fetchJson(response, '阿里云百炼千问');
  const message = payload?.choices?.[0]?.message?.content;
  const output = typeof message === 'string' ? message : Array.isArray(message) ? message.map((item) => item.text || '').join('') : '';
  if (!output) throw new Error('千问已返回响应，但没有找到提示词。');
  return parsePromptResult(output);
}

function mapRegionAnalysisInstructions(body) {
  if (body.task === 'collision') {
    return `你是2D游戏地图的碰撞格标注助手。查看附图中的地图和网格。网格内每格中心印有(row,col)坐标，坐标与Unity导出一致；网格布局=${body.layout}，行=${body.rows}，列=${body.columns}。只判断角色脚底是否无法通过的地面占用格：建筑墙体/地基、围墙、不可穿越的岩石、悬崖、深水等要标记；开放地面、道路、广场可通行；树冠、屋顶、阴影、平面装饰不要仅因覆盖画面就标记，应判断其落地占地。对于边界或被遮挡无法判断的格子放入uncertain，不要猜测。只返回图中实际存在的坐标，每个坐标最多一次。输出严格JSON：{"cells":[{"row":0,"col":0,"confidence":0.9,"reason":"简短原因"}],"uncertain":[{"row":0,"col":0,"reason":"简短原因"}]}。confidence为0到1。不要返回Markdown。`;
  }
  return `你是2D游戏地图的遮挡排序标注助手。附图是由已提取的透明物件图层合成在洋红色背景上的整张地图，洋红色表示透明空白，不是场景内容。地图坐标原点在图像左上角，X向右、Y向下；将坐标范围归一化到0..1000。只标记角色走到其后方时应被角色遮住的前景部分，例如树冠/前景树枝、建筑靠近镜头一侧的墙檐、桥梁前沿栏杆。不要把整座建筑、地面、投影或背景空白整体圈成遮挡区；一个区域应是紧贴真实前景物件的简单多边形，尽量少顶点，最多12个顶点。每个polygon是归一化坐标点数组[[x,y],...]；baselineY是该前景物件脚底排序线的归一化Y值(0..1000)，即角色脚底Y超过该值时前景物件应绘制在角色前面。只返回清楚可辨的区域；不确定对象列入uncertain。最多返回40个区域。输出严格JSON：{"regions":[{"name":"简短名称","polygon":[[100,200],[300,200],[300,500]],"baselineY":500,"confidence":0.9,"reason":"简短原因"}],"uncertain":["简短说明"]}。不要返回Markdown。`;
}

function mapRegionAnalysisSchema(task) {
  const cell = {
    type: 'object', properties: { row: { type: 'integer' }, col: { type: 'integer' }, confidence: { type: 'number' }, reason: { type: 'string' } },
    required: ['row', 'col', 'confidence', 'reason'], additionalProperties: false,
  };
  if (task === 'collision') return {
    type: 'object', properties: { cells: { type: 'array', items: cell }, uncertain: { type: 'array', items: { type: 'object', properties: { row: { type: 'integer' }, col: { type: 'integer' }, reason: { type: 'string' } }, required: ['row', 'col', 'reason'], additionalProperties: false } } },
    required: ['cells', 'uncertain'], additionalProperties: false,
  };
  return {
    type: 'object', properties: { regions: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, polygon: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, baselineY: { type: 'number' }, confidence: { type: 'number' }, reason: { type: 'string' },
    }, required: ['name', 'polygon', 'baselineY', 'confidence', 'reason'], additionalProperties: false } }, uncertain: { type: 'array', items: { type: 'string' } } },
    required: ['regions', 'uncertain'], additionalProperties: false,
  };
}

function geminiRegionSchema(task) {
  const cell = { type: 'OBJECT', properties: { row: { type: 'INTEGER' }, col: { type: 'INTEGER' }, confidence: { type: 'NUMBER' }, reason: { type: 'STRING' } }, required: ['row', 'col', 'confidence', 'reason'] };
  if (task === 'collision') return { type: 'OBJECT', properties: {
    cells: { type: 'ARRAY', items: cell },
    uncertain: { type: 'ARRAY', items: { type: 'OBJECT', properties: { row: { type: 'INTEGER' }, col: { type: 'INTEGER' }, reason: { type: 'STRING' } }, required: ['row', 'col', 'reason'] } },
  }, required: ['cells', 'uncertain'] };
  return { type: 'OBJECT', properties: {
    regions: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      name: { type: 'STRING' }, polygon: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'NUMBER' } } }, baselineY: { type: 'NUMBER' }, confidence: { type: 'NUMBER' }, reason: { type: 'STRING' },
    }, required: ['name', 'polygon', 'baselineY', 'confidence', 'reason'] } },
    uncertain: { type: 'ARRAY', items: { type: 'STRING' } },
  }, required: ['regions', 'uncertain'] };
}

function parseMapRegionAnalysis(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(cleaned);
  if (!value || typeof value !== 'object') throw new Error('识别模型返回内容格式不正确。');
  return value;
}

async function analyzeMapRegionsWithProvider(settings, body) {
  const instructions = mapRegionAnalysisInstructions(body), schema = mapRegionAnalysisSchema(body.task), mimeType = body.imageMimeType || 'image/jpeg';
  let output = '';
  if (body.provider === 'openai') {
    const response = await fetchProvider('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${settings.openaiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.openaiPromptModel, input: [{ role: 'user', content: [
        { type: 'input_text', text: instructions }, { type: 'input_image', image_url: `data:${mimeType};base64,${body.imageBase64}`, detail: 'high' },
      ] }], text: { format: { type: 'json_schema', name: 'map_region_analysis', strict: true, schema } } }),
    }, 'OpenAI');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(providerMessage(payload, `OpenAI API 请求失败（${response.status}）`)), { status: response.status });
    output = getOpenAIOutputText(payload);
  } else if (body.provider === 'gemini') {
    const response = await fetchProvider(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiPromptModel)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.geminiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [
        { text: instructions }, { inline_data: { mime_type: mimeType, data: body.imageBase64 } },
      ] }], generationConfig: { responseMimeType: 'application/json', responseSchema: geminiRegionSchema(body.task) } }),
    }, 'Google Gemini');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(providerMessage(payload, `Google API 请求失败（${response.status}）`)), { status: response.status });
    output = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  } else {
    const response = await fetchProvider(qwenProviderUrl(settings, '/compatible-mode/v1/chat/completions'), {
      method: 'POST', headers: { authorization: `Bearer ${settings.qwenKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.qwenPromptModel, messages: [{ role: 'user', content: [
        { type: 'text', text: instructions }, { type: 'image_url', image_url: { url: decodeDataUrl(body.imageBase64, mimeType) } },
      ] }], response_format: { type: 'json_object' } }),
    }, '阿里云百炼千问');
    const payload = await fetchJson(response, '阿里云百炼千问'), message = payload?.choices?.[0]?.message?.content;
    output = typeof message === 'string' ? message : Array.isArray(message) ? message.map((item) => item.text || '').join('') : '';
  }
  if (!output) throw new Error('识别模型没有返回结果。');
  return parseMapRegionAnalysis(output);
}

function providerConfig(settings) {
  return {
    mapCapabilities: { ...MAP_CAPABILITIES, gemini: { ...MAP_CAPABILITIES.gemini, resolutions: geminiResolutions(settings.geminiModel), groundResolutions: geminiGroundResolutions(settings.geminiModel) } },
    configured: {
      openai: Boolean(settings.openaiKey),
      gemini: Boolean(settings.geminiKey),
      qwen: Boolean(settings.qwenKey),
      kling: Boolean(settings.klingKey),
    },
    models: {
      openai: settings.openaiModel,
      gemini: settings.geminiModel,
      openaiPrompt: settings.openaiPromptModel,
      geminiPrompt: settings.geminiPromptModel,
      qwen: settings.qwenImageModel,
      qwenPrompt: settings.qwenPromptModel,
      qwenBaseUrl: settings.qwenBaseUrl,
      kling: settings.klingModel,
      klingObjects: KLING_OBJECT_MODEL,
      klingBaseUrl: settings.klingBaseUrl,
    },
  };
}

function providerApiKey(settings, provider) {
  return ({ openai: settings.openaiKey, gemini: settings.geminiKey, qwen: settings.qwenKey, kling: settings.klingKey })[provider] || '';
}

function providerLabel(provider) {
  return ({ openai: 'OpenAI', gemini: 'Google', qwen: '阿里云百炼千问', kling: '可灵' })[provider] || '所选服务';
}

function providerModel(settings, provider, modality) {
  return ({
    openai: modality === 'prompt' ? settings.openaiPromptModel : settings.openaiModel,
    gemini: modality === 'prompt' ? settings.geminiPromptModel : settings.geminiModel,
    qwen: modality === 'prompt' ? settings.qwenPromptModel : settings.qwenImageModel,
    kling: modality === 'objects' ? KLING_OBJECT_MODEL : settings.klingModel,
  })[provider];
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  const allowedOrigin = `http://${host}:5173`;
  if (origin && origin !== allowedOrigin) return json(response, 403, { error: '只允许本机网页访问此服务。' });
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-origin': allowedOrigin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return response.end();
  }

  const url = new URL(request.url, `http://${host}:${port}`);
  try {
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const settings = await readSettings();
      return json(response, 200, providerConfig(settings));
    }

    if (request.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(request, 32 * 1024);
      const settings = await readSettings();
      if (typeof body.openaiKey === 'string' && body.openaiKey.trim()) settings.openaiKey = body.openaiKey.trim();
      if (typeof body.geminiKey === 'string' && body.geminiKey.trim()) settings.geminiKey = body.geminiKey.trim();
      if (typeof body.qwenKey === 'string' && body.qwenKey.trim()) settings.qwenKey = body.qwenKey.trim();
      if (typeof body.klingKey === 'string' && body.klingKey.trim()) settings.klingKey = body.klingKey.trim();
      if (body.clearOpenaiKey === true) settings.openaiKey = '';
      if (body.clearGeminiKey === true) settings.geminiKey = '';
      if (body.clearQwenKey === true) settings.qwenKey = '';
      if (body.clearKlingKey === true) settings.klingKey = '';
      if (typeof body.openaiModel === 'string' && body.openaiModel.trim()) settings.openaiModel = body.openaiModel.trim();
      if (typeof body.geminiModel === 'string' && body.geminiModel.trim()) settings.geminiModel = body.geminiModel.trim();
      if (typeof body.openaiPromptModel === 'string' && body.openaiPromptModel.trim()) settings.openaiPromptModel = body.openaiPromptModel.trim();
      if (typeof body.geminiPromptModel === 'string' && body.geminiPromptModel.trim()) settings.geminiPromptModel = body.geminiPromptModel.trim();
      if (typeof body.qwenBaseUrl === 'string' && body.qwenBaseUrl.trim()) settings.qwenBaseUrl = providerBaseUrl(body.qwenBaseUrl, '千问');
      if (typeof body.qwenImageModel === 'string' && body.qwenImageModel.trim()) settings.qwenImageModel = body.qwenImageModel.trim();
      if (typeof body.qwenPromptModel === 'string' && body.qwenPromptModel.trim()) settings.qwenPromptModel = body.qwenPromptModel.trim();
      if (typeof body.klingBaseUrl === 'string' && body.klingBaseUrl.trim()) settings.klingBaseUrl = providerBaseUrl(body.klingBaseUrl, '可灵');
      if (typeof body.klingModel === 'string' && body.klingModel.trim()) settings.klingModel = body.klingModel.trim();
      await saveSettings(settings);
      return json(response, 200, providerConfig(settings));
    }

    if (request.method === 'POST' && url.pathname === '/api/scene/prompt') {
      const body = await readBody(request);
      if (!['openai', 'gemini', 'qwen'].includes(body.provider)) return json(response, 400, { error: '请选择有效的提示词服务。' });
      const settings = await readSettings();
      if (!providerApiKey(settings, body.provider)) return json(response, 400, { error: `还没有配置 ${providerLabel(body.provider)} API key。请先打开“服务设置”。` });
      const result = body.provider === 'openai' ? await draftWithOpenAI(settings, body) : body.provider === 'gemini' ? await draftWithGemini(settings, body) : await draftWithQwen(settings, body);
      return json(response, 200, { ...result, model: providerModel(settings, body.provider, 'prompt') });
    }

    if (request.method === 'POST' && url.pathname === '/api/map/regions/analyze') {
      const body = await readBody(request);
      if (!['openai', 'gemini', 'qwen'].includes(body.provider)) return json(response, 400, { error: '请选择支持图片分析的 AI 服务：OpenAI、Gemini 或千问。' });
      if (!['collision', 'occlusion'].includes(body.task)) return json(response, 400, { error: '请选择有效的自动标记类型。' });
      if (typeof body.imageBase64 !== 'string' || !body.imageBase64 || !/^image\/(png|jpeg|webp)$/.test(body.imageMimeType || 'image/jpeg')) return json(response, 400, { error: '缺少有效的地图分析图片。' });
      if (body.task === 'collision' && (!Number.isInteger(body.columns) || !Number.isInteger(body.rows) || body.columns < 1 || body.rows < 1 || body.columns > 64 || body.rows > 64)) return json(response, 400, { error: '网格行列参数无效。' });
      const settings = await readSettings();
      if (!providerApiKey(settings, body.provider)) return json(response, 400, { error: `还没有配置 ${providerLabel(body.provider)} API key。请先打开“服务设置”。` });
      const analysis = await analyzeMapRegionsWithProvider(settings, body);
      return json(response, 200, { analysis, model: providerModel(settings, body.provider, 'prompt') });
    }

    if (request.method === 'POST' && url.pathname === '/api/scene/generate') {
      const body = await readBody(request);
      if (!['openai', 'gemini', 'qwen', 'kling'].includes(body.provider)) return json(response, 400, { error: '请选择有效的图像服务。' });
      if (!body.prompt?.trim() || !Number.isFinite(Number(body.width)) || !Number.isFinite(Number(body.height)) || Number(body.width) <= 0 || Number(body.height) <= 0) {
        return json(response, 400, { error: '缺少提示词或有效的图像尺寸。' });
      }
      const settings = await readSettings();
      if (!providerApiKey(settings, body.provider)) return json(response, 400, { error: `还没有配置 ${providerLabel(body.provider)} API key。请先打开“服务设置”。` });
      const globalPrompts = appendGlobalPrompts(body.prompt, body.negativePrompt, body.globalDescription, body.globalPositivePrompt, body.globalNegativePrompt);
      const imageRequest = {
        ...body,
        ...globalPrompts,
        imageBase64: body.imageBase64 || body.referenceImageBase64 || '',
        mimeType: body.mimeType || body.referenceMimeType || 'image/png',
      };
      const image = body.provider === 'openai' ? await generateWithOpenAI(settings, imageRequest) : body.provider === 'gemini' ? await generateWithGemini(settings, imageRequest) : body.provider === 'qwen' ? await generateWithQwen(settings, imageRequest) : await generateWithKling(settings, imageRequest);
      return json(response, 200, { imageBase64: image.data, mimeType: image.mimeType, model: providerModel(settings, body.provider, 'image') });
    }

    if (request.method === 'POST' && url.pathname === '/api/map/style') {
      const body = await readBody(request);
      if (!['gemini', 'openai', 'qwen'].includes(body.provider)) return json(response, 400, { error: '请选择有效的提示词服务。' });
      if (!body.referenceImageBase64) return json(response, 400, { error: '请先上传参考图。' });
      const settings = await readSettings();
      if (!providerApiKey(settings, body.provider)) return json(response, 400, { error: '请先配置所选提示词服务的 API key。' });
      const draft = { gemini: draftWithGemini, openai: draftWithOpenAI, qwen: draftWithQwen }[body.provider];
      const result = await draft(settings, body, STYLE_EXTRACTION_INSTRUCTIONS);
      if (!result.prompt.trim()) throw new Error('没有提炼到有效风格描述，原有文字未修改。');
      return json(response, 200, { ...result, model: providerModel(settings, body.provider, 'prompt') });
    }
    if (request.method === 'POST' && ['/api/map/generate', '/api/map/preview'].includes(url.pathname)) {
      const settings = await readSettings();
      const body = validateMapRequest(await readBody(request), settings);
      const diagnostics = mapDiagnostics(settings, body, providerModel(settings, body.provider, body.operation === 'objects' ? 'objects' : 'image'));
      if (url.pathname === '/api/map/preview') return json(response, 200, { diagnostics });
      if (diagnostics.validationError) return json(response, 400, { error: diagnostics.validationError, diagnostics, submitted: false });
      if (!providerApiKey(settings, body.provider)) return json(response, 400, { error: `还没有配置 ${providerLabel(body.provider)} API key。请先打开“服务设置”。`, diagnostics, submitted: false });
      const controller = new AbortController(), submission = { submitted: false };
      const abort = () => { if (!response.writableEnded) controller.abort(); };
      request.once('aborted', abort); response.once('close', abort);
      try {
        const image = await mapSubmissionContext.run(submission, () => mapRequestContext.run(AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)]), () => body.provider === 'openai' ? generateWithOpenAI(settings, body) : body.provider === 'gemini' ? generateWithGemini(settings, body) : body.provider === 'qwen' ? generateWithQwen(settings, body) : generateWithKling(settings, body)));
        if (!controller.signal.aborted) return json(response, 200, { imageBase64: image.data, mimeType: image.mimeType, model: diagnostics.model, diagnostics, submitted: submission.submitted, ...(image.generation ? { generation: image.generation } : {}) });
        return;
      } catch (error) {
        if (!controller.signal.aborted) return json(response, Number(error.status) || 500, { error: error.message, diagnostics, submitted: submission.submitted });
      } finally { request.off('aborted', abort); response.off('close', abort); }
    }

    if (request.method === 'POST' && url.pathname === '/api/generate') {
      const body = await readBody(request);
      if (!['openai', 'gemini', 'qwen', 'kling'].includes(body.provider)) return json(response, 400, { error: '请选择有效的图像服务。' });
      if (!body.imageBase64 || !body.prompt || !body.width || !body.height) return json(response, 400, { error: '缺少底图、提示词或尺寸信息。' });
      const settings = await readSettings();
      if (!providerApiKey(settings, body.provider)) return json(response, 400, { error: `还没有配置 ${providerLabel(body.provider)} API key。请先打开“服务设置”。` });
      const image = body.provider === 'openai' ? await generateWithOpenAI(settings, body) : body.provider === 'gemini' ? await generateWithGemini(settings, body) : body.provider === 'qwen' ? await generateWithQwen(settings, body) : await generateWithKling(settings, body);
      return json(response, 200, { imageBase64: image.data, mimeType: image.mimeType, model: providerModel(settings, body.provider, 'image') });
    }

    return json(response, 404, { error: '找不到此接口。' });
  } catch (error) {
    const status = Number(error.status) || 500;
    console.error(`[api] ${request.method} ${url.pathname}: ${error.message}`);
    return json(response, status, { error: error.message || '本机服务出现错误。' });
  }
});

export { generateWithGemini, generateWithOpenAI, generateWithQwen, generateWithKling, draftWithOpenAI, draftWithGemini, draftWithQwen, server };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) server.listen(port, host, () => {
  console.log(`地图拼接服务已启动： http://${host}:${port}`);
  console.log('API key 只保存在本机 .local-settings.json，不会返回到网页。');
});
