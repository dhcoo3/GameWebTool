import { canvas, canvasBlob, storeCanvas, requestImage, assetImage } from '../src/map/images.js';
import { referenceSample, seedReference } from '../src/map/referenceImages.js';
import { normalizeReferenceSettings } from '../src/map/reference.js';
import { DIRECTIONS, DRAFT_ID } from '../src/map/core.js';
import { saveProject, readProject, migrateProject } from '../src/map/storage.js';
import { exportProject, importProjectZip } from '../src/map/exports.js';

export async function testReferenceEngine({ getEngine, p, assert, tick, wait, reset, mock, imageResponse, getRequests }) {
  const native = window.fetch, extraction = [], previews = []; let failStyle = false;
  window.fetch = async (url, options) => {
    if (url === '/api/map/style') { extraction.push(JSON.parse(options.body)); return failStyle ? Response.json({ error: '模拟提炼失败' }, { status: 503 }) : Response.json({ prompt: 'STYLE_TEXT', negativePrompt: 'STYLE_AVOID', model: 'mock-style-model' }); }
    if (url === '/api/map/preview') previews.push(JSON.parse(options.body));
    return mock(url, options);
  };
  try {
    const e = () => getEngine(), sample = canvas(80, 40), sc = sample.getContext('2d'); sc.fillStyle = '#ff0000'; sc.fillRect(0, 0, 40, 40); sc.fillStyle = '#0000ff'; sc.fillRect(40, 0, 40, 40);
    const styleAssetId = await storeCanvas(sample, e().assets), crop = { x: .5, y: 0, width: .5, height: 1 };
    const referenceSettings = { ...normalizeReferenceSettings(), crop };
    await reset({ ...p, styleAssetId, referenceSettings, tiles: [] });
    const cropped = await referenceSample(e().project, e().assets);
    assert(cropped.width === 40 && cropped.height === 40 && cropped.getContext('2d').getImageData(10, 10, 1, 1).data[2] === 255, '局部取样不正确');
    const full = await referenceSample({ ...e().project, referenceSettings: { ...referenceSettings, mode: 'layout' } }, e().assets); assert(full.width === 80, '布局模式误用局部取样');
    for (const provider of ['gemini', 'openai', 'qwen', 'kling']) for (const mode of ['style', 'layout', 'both']) {
      await reset({ ...p, styleAssetId, provider, tiles: [], referenceSettings: { ...referenceSettings, mode } });
      const before = getRequests().length;
      const preview = await e().previewPrompts('seed'); assert(getRequests().length === before, '预览触发了生图');
      await e().seed(); await tick();
      const actual = getRequests().at(-1), log = e().project.requestLog;
      assert(actual.reference.mode === mode && actual.imageBase64 && actual.scaleReference, '图片参考或比例未传递');
      assert(log.requests.length === 1 && log.requests[0].diagnostics.prompt === preview[0].prompt, '预览与实际记录不一致');
      assert(!JSON.stringify(log).includes(actual.imageBase64), '记录保存了图片Base64');
    }
    await reset({ ...p, styleAssetId, referenceSettings, tiles: [] });
    const before = extraction.length; await e().extractStyle(); await tick();
    assert(extraction.length === before + 1 && e().project.referenceSettings.positive === 'STYLE_TEXT', '风格提炼不是单次调用');
    e().patch({ referenceSettings: { ...e().project.referenceSettings, input: 'text', positive: 'MANUAL_STYLE' } }); await tick();
    failStyle = true; await e().extractStyle(); await tick(); assert(e().project.referenceSettings.positive === 'MANUAL_STYLE', '提炼失败覆盖手动文字'); failStyle = false;
    const prepared = await seedReference(e().project, e().assets); assert(!prepared, '文字模式仍准备参考图片');
    await e().seed(); await tick();
    const textBody = getRequests().at(-1); assert(!textBody.imageBase64 && textBody.reference.positive === 'MANUAL_STYLE', '文字模式上传了图片或未传文字');
    const logBefore = e().project.requestLog.id;
    const confirm = window.confirm; window.confirm = () => true;
    try { await e().seed(); await tick(); } finally { window.confirm = confirm; }
    assert(getRequests().at(-1).reference.input === 'text' && e().project.requestLog.id !== logBefore && e().project.requestLog.requests.length === 1, '主图重生成未沿用模式或新任务未替换记录');
    const expected = e().project.referenceSettings, savedLog = e().project.requestLog;
    const saved = await saveProject(e().project), reopened = await migrateProject(await readProject(saved.id), e().assets);
    assert(reopened.referenceSettings.positive === 'MANUAL_STYLE' && reopened.requestLog.id === savedLog.id, '项目丢失设置或日志');
    await saveProject(e().project, true); const draft = await migrateProject(await readProject(DRAFT_ID), e().assets); assert(draft.referenceSettings.source.sourceAssetId === styleAssetId, '草稿丢失提炼来源');
    const zip = await exportProject(e().project, e().assets), portable = await importProjectZip(new File([zip], 'reference.zip'), e().assets);
    assert(portable.styleAssetId === portable.referenceSettings.source.sourceAssetId && portable.referenceSettings.positive === expected.positive && portable.requestLog.requests.length === 1, 'ZIP 丢失参考来源或日志');
    assert((await assetImage(styleAssetId, e().assets)).width === 80, '取样覆盖了原图');
    // Importing a new map preserves the reference settings and the source image.
    await reset({ ...p, styleAssetId, referenceSettings: expected, tiles: [] });
    await e().importBase(new File([await canvasBlob(canvas(128, 80))], 'new.png', { type: 'image/png' })); await tick();
    assert(e().project.styleAssetId === styleAssetId && e().project.referenceSettings.input === 'text', '导入新底图丢失参考设置');
    // Segments and queue resume retain all actual per-request records.
    await reset({ ...p, subdivisions: 2, styleAssetId, referenceSettings: expected });
    const expanded = await e().previewPrompts('expand', { direction: DIRECTIONS.find((d) => d.id === 'e') }); assert(expanded.length === 4, '预览未覆盖各分段');
    await e().expand(DIRECTIONS.find((d) => d.id === 'e')); await tick();
    assert(e().project.requestLog.requests.length === 4 && e().project.requestLog.requests.every((r) => r.diagnostics.referenceInput === 'map'), '扩图记录漏分段或混入初始参考模式');
    const pts = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }];
    const retouch = await e().previewPrompts('retouch', { points: pts, prompt: '修复' });
    e().discard(); await tick(); await e().retouch(pts, '修复'); await tick();
    assert(e().project.requestLog.requests[0].diagnostics.prompt === retouch[0].prompt, '重绘预览与实际不同');
    e().discard(); await tick();
    await reset({ ...p, subdivisions: 2 });
    let release; const priorFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (url === '/api/map/generate' && !release) return new Promise((resolve) => { release = () => resolve(imageResponse(JSON.parse(options.body))); });
      return priorFetch(url, options);
    };
    e().startBatch(2, 2, 1); await wait(() => release);
    e().pauseBatch(); await tick(); release(); await wait(() => !e().pumpActive);
    const queueId = e().project.queue.id, count = e().project.requestLog.requests.length;
    assert(count > 0 && e().project.requestLog.id === queueId, '自动任务没有同组记录');
    const paused = await saveProject(e().project); await reset(p); await e().load(paused); await tick();
    e().resumeBatch(); await wait(() => !e().pumpActive && e().project.queue.status === 'complete');
    assert(e().project.requestLog.id === queueId && e().project.requestLog.requests.length > count, '恢复任务丢弃历史记录');
    window.fetch = priorFetch;
    // Service rejects a request before submission; diagnostics and failure state remain visible.
    await reset(p); window.fetch = async (url, options) => url === '/api/map/generate' ? Response.json({ error: '模拟超长拦截', submitted: false, diagnostics: { prompt: 'FULL_CONTENT', negativePrompt: '' } }, { status: 400 }) : priorFetch(url, options);
    await e().expand(DIRECTIONS.find((d) => d.id === 'e')); await tick();
    assert(e().project.requestLog.requests[0].status === 'failed' && e().project.requestLog.requests[0].submitted === false && e().project.requestLog.requests[0].diagnostics.prompt === 'FULL_CONTENT', '失败未提交记录缺失');
    assert(previews.length > 0, '未运行预览路径');
  } finally { window.fetch = native; }
}
