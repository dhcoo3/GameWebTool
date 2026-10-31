import { validateMapRequest } from '../server/map.js';
import { mapDiagnostics } from '../server/providerPrompts.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { readPsd } from 'ag-psd';
import { unzipSync } from 'fflate';
import useMapEngine from '../src/map/useMapEngine.js';
import { DIRECTIONS, DRAFT_ID, mapBounds, newProject, normalizeProject, tileRect, uid } from '../src/map/core.js';
import { assetImage, canvas, canvasBlob, generateTile, loadImage, processedMatte, renderRect, storeCanvas, generateGround, requestImage } from '../src/map/images.js';
import { AssetStore, listProjects, migrateProject, readProject, saveProject } from '../src/map/storage.js';
import { download, exportLayers, exportParts, exportPng, exportProject, exportPsd, importProjectZip } from '../src/map/exports.js';
import { characterImageBounds } from '../src/map/characterImage.js';
import { applySizeStandard, rescaleObjectSizes } from '../src/map/objectSizes.js';
import { normalizeScaleReference, scaleGenerationFingerprint } from '../src/map/scale.js';
import { layerAlphaValid, validLayerPair, importLayerImage } from '../src/map/layers.js';
import { geminiGroundFrame, resolveGeminiGround, DEFAULT_GEMINI_MODEL } from '../src/map/geminiResolution.js';
import DirectLayerControls from '../src/map/DirectLayerControls.jsx';

const results = document.querySelector('#results'), assert = (v, m) => { if (!v) throw new Error(m); }, nativeFetch = window.fetch;
const config = { configured: { gemini: true, openai: true, qwen: true, kling: true }, models: { gemini: DEFAULT_GEMINI_MODEL } };
let H, handler, requests = [], messages = [], successful = 0;
function Harness() { H = useMapEngine({ config, serverOffline: false, onOpenSettings: () => {}, notify: React.useCallback((m) => messages.push(m), []) }); return <><p>测试状态：{H.ready ? '就绪' : '初始化'} · {H.project.tiles.length} 块 · {H.project.queue?.status || '空闲'}</p><div id="ground-controls"><DirectLayerControls project={H.project} tile={H.selectedTile} engine={H} notify={(m) => messages.push(m)} config={config}/></div></>; }
createRoot(document.querySelector('#harness')).render(<Harness/>);
const tick = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function wait(fn, message = '等待超时') { const start = Date.now(); while (!fn()) { if (Date.now() - start > 18000) throw new Error(message); await tick(); } }
async function test(name, action) { try { await action(); successful++; results.textContent += `✓ ${name}\n`; } catch (e) { results.textContent += `✗ ${name}: ${e.stack || e.message}\n`; throw e; } }
async function mock(url, options = {}) {
  if (String(url) === '/api/map/preview') {
    const body = JSON.parse(options.body);
    return Response.json({ diagnostics: mockDiagnostics(body) });
  }
  if (String(url) !== '/api/map/generate') return nativeFetch(url, options);
  const body = JSON.parse(options.body); requests.push(body); if (handler) return handler(body, options);
  return imageResponse(body);
}
const mockDiagnostics = (body) => mapDiagnostics({ geminiModel: DEFAULT_GEMINI_MODEL, qwenImageModel: 'qwen-image-3.0-pro' }, validateMapRequest(body), 'mock-model');
function imageResponse(body) {
  const c = canvas(body.width, body.height), ctx = c.getContext('2d');
  if (body.operation === 'objects') { ctx.fillStyle = '#923b36'; ctx.fillRect(20, 10, 30, 40); return Response.json({ imageBase64: c.toDataURL().split(',')[1], mimeType: 'image/png', model: 'mock-object-model', diagnostics: mockDiagnostics(body), submitted: true }); }
  ctx.fillStyle = body.operation === 'matte' ? '#000' : '#369768'; ctx.fillRect(0, 0, c.width, c.height);
  if (body.operation === 'matte') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width / 2, c.height); }
  return Response.json({ imageBase64: c.toDataURL().split(',')[1], mimeType: 'image/png', model: 'mock-model', diagnostics: mockDiagnostics(body), submitted: true });
}
async function fixture(assets = H.assets) {
  const c = canvas(128, 80), ctx = c.getContext('2d'), data = ctx.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; data.data.set([x, y * 2, (x + y) % 255, 255], i); }
  ctx.putImageData(data, 0, 0); ctx.clearRect(2, 2, 4, 4);
  const originalId = await storeCanvas(c, assets);
  return { ...newProject(), scaleReference: normalizeScaleReference({ enabled: true, environmentRulesEnabled: true, heightPx: 96 }), name: '验收样例', tileWidth: c.width, tileHeight: c.height, tiles: [{ id: uid(), x: 0, y: 0, px: 0, py: 0, width: c.width, height: c.height, originalId, kind: 'base', name: '彩色坐标底图' }] };
}
const pixels = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
const equal = (a, b, m) => assert(a.length === b.length && a.every((v, i) => v === b[i]), m);
async function reset(p) { handler = null; requests = []; H.apply(p); H.setSelectedId(p.tiles[0]?.id || ''); await tick(); }
document.querySelector('#run').onclick = async () => {
  document.querySelector('#run').disabled = true; results.textContent = ''; successful = 0; window.fetch = mock;
  try {
    await wait(() => H?.ready);
    const p = await fixture();
    await test('参考用途、文字提炼、局部取样、预览与任务记录完整往返', async () => {
      const { testReferenceEngine } = await import('./reference-browser.jsx');
      await testReferenceEngine({ getEngine: () => H, p, assert, tick, wait, reset, mock, imageResponse, getRequests: () => requests });
    });
    await test('导出底图兜底：原图、透明物件、完整分层、预览未接纳、混合图块与PNG/PSD/Unity一致', async () => {
      const { testExportBackground } = await import('./export-background.jsx');
      await testExportBackground({ assets: H.assets, assert });
    });
    await test('多区域完整界面：连续闭合、按钮/Enter/双击、逐点历史、状态切换与PSD/Unity往返', async () => {
      const { testRegionUi } = await import('./region-browser.jsx');
      await testRegionUi({ p, assets: H.assets, assert, tick, wait });
    });
    await test('区域类型过滤：右侧列表属性独立，画布保留所有类型参考标记', async () => {
      const { testRegionTypeUi } = await import('./region-browser.jsx');
      await testRegionTypeUi({ p, assert, tick, wait });
    });
    await test('完整物件库无需图片、规范与缩放撤销、草稿ZIP、缓存和角色载入保护', async () => {
      await reset({ ...p, scaleReference: newProject().scaleReference });
      assert(H.project.scaleReference.heightPx === 44 && !H.project.scaleReference.characterAssetId, '新规范默认错误');
      requests = []; await H.expand(DIRECTIONS.find((d) => d.id === 'e')); await tick();
      assert(requests[0].scaleReference.objectSizes.entries.length === 11, '无图片时未发送完整库');
      const original = H.project.scaleReference;
      H.updateScaleReference({ objectSizes: { ...original.objectSizes, entries: original.objectSizes.entries.map((e) => e.id === 'rock' ? { ...e, enabled: false } : e) } }, true); await tick();
      assert(!H.pending && !H.project.work, '关闭类别未清除预览');
      await H.expand(DIRECTIONS.find((d) => d.id === 'e')); await tick();
      const off = H.project.scaleReference.objectSizes;
      H.updateScaleReference({ objectSizes: { ...off, entries: off.entries.map((e) => e.id === 'rock' ? { ...e, height: { min: 25, max: 50 } } : e) } }, true); await tick();
      assert(H.pending, '关闭类别编辑误清除预览'); H.discard(); await tick();
      const custom = { id: 'custom-pillar', name: '石柱', enabled: true, height: { min: 50, max: 80 }, width: { min: 15, max: 25 } };
      H.updateScaleReference({ objectSizes: { ...off, entries: [...off.entries, custom] }, heightPx: 88 }, true); await tick();
      H.updateScaleReference(rescaleObjectSizes(H.project.scaleReference), true); await tick();
      assert(H.project.scaleReference.objectSizes.entries.at(-1).height.min === 100, '自定义缩放失败');
      H.undo(); await tick(); assert(H.project.scaleReference.objectSizes.entries.at(-1).height.min === 50, '缩放撤销失败');
      H.updateScaleReference(applySizeStandard(H.project.scaleReference), true); await tick();
      assert(H.project.scaleReference.heightPx === 44 && H.project.scaleReference.objectSizes.entries.at(-1).name === '石柱', '应用规范丢失自定义');
      const expected = JSON.stringify(H.project.scaleReference.objectSizes), width = H.project.scaleReference.widthPx;
      await H.loadScalePreset(); await tick(); assert(H.project.scaleReference.heightPx === 44 && H.project.scaleReference.widthPx === width && JSON.stringify(H.project.scaleReference.objectSizes) === expected, '载入图片覆盖尺寸库');
      const saved = await saveProject(H.project); await reset(p); await H.load(saved); await tick();
      assert(JSON.stringify(H.project.scaleReference.objectSizes) === expected, '项目丢失物件库');
      await saveProject(H.project, true); const draft = await migrateProject(await readProject(DRAFT_ID), H.assets);
      assert(JSON.stringify(draft.scaleReference.objectSizes) === expected, '草稿丢失物件库');
      const zip = await exportProject(H.project, H.assets), portable = await importProjectZip(new File([zip], 'sizes.zip'), H.assets);
      assert(JSON.stringify(portable.scaleReference.objectSizes) === expected, 'ZIP 丢失物件库');
      handler = (b) => Promise.resolve(imageResponse(b)); requests = [];
      H.startBatch(2, 2, 1); await wait(() => !H.pumpActive && H.project.queue?.status === 'complete');
      assert(H.project.queue.settings.scaleReference.objectSizes.entries.at(-1).name === '石柱' && requests.every((b) => b.scaleReference.objectSizes.entries.at(-1).name === '石柱'), '队列未保留库快照');
      handler = null;
    });
    await test('全局规则保存、ZIP 往返、请求传递与旧预览失效', async () => {
      const rules = { globalPositivePrompt: 'GLOBAL_STYLE', globalNegativePrompt: 'GLOBAL_AVOID' };
      await reset({ ...p, ...rules });
      const saved = await saveProject(H.project), reopened = await migrateProject(await readProject(saved.id), H.assets);
      assert(reopened.globalPositivePrompt === rules.globalPositivePrompt, '保存丢失全局规则');
      await saveProject(H.project, true);
      const draft = await migrateProject(await readProject(DRAFT_ID), H.assets);
      assert(draft.globalNegativePrompt === rules.globalNegativePrompt, '草稿丢失全局规则');
      assert(newProject().globalPositivePrompt === '', '规则泄漏到新项目');
      const zip = await exportProject(H.project, H.assets), portable = await importProjectZip(new File([zip], 'rules.zip'), H.assets);
      assert(portable.globalNegativePrompt === rules.globalNegativePrompt, 'ZIP 丢失全局规则');
      for (const provider of ['gemini', 'openai', 'qwen', 'kling']) {
        await reset({ ...p, ...rules, provider }); requests = [];
        await H.expand(DIRECTIONS.find((d) => d.id === 'e')); await tick();
        assert(requests[0].globalPositivePrompt === rules.globalPositivePrompt, '扩图未传递规则');
        assert(!requests[0].prompt.includes('GLOBAL_STYLE'), '浏览器提前合并了规则');
        H.patch({ globalNegativePrompt: 'NEW_AVOID' }); await tick();
        assert(!H.pending && !H.project.work, '修改规则未清除旧预览与分段');
        requests = []; await H.retouch([{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }], '修复'); await tick();
        assert(requests[0].globalNegativePrompt === 'NEW_AVOID', '重绘规则丢失'); H.discard(); await tick();
        await reset({ ...p, ...rules, provider, tiles: [] }); requests = []; await H.seed(); await tick();
        assert(requests[0].globalPositivePrompt === rules.globalPositivePrompt, '初始图未传递规则');
        const confirm = window.confirm; window.confirm = () => true;
        try { requests = []; await H.seed(); await tick(); assert(requests[0].globalPositivePrompt === rules.globalPositivePrompt, '重生成主图未传递规则'); }
        finally { window.confirm = confirm; }
        const source = canvas(128, 80);
        for (const operation of ['ground', 'matte']) {
          requests = []; await requestImage({ ...H.project, ...rules }, H.assets, operation, { image: source, fetcher: mock });
          assert(!requests[0].globalPositivePrompt && !requests[0].prompt.includes('GLOBAL_STYLE'), '分层混入全局规则');
        }
      }
      await reset({ ...p, ...rules }); let release;
      handler = (b) => new Promise((resolve) => { release = () => resolve(imageResponse(b)); });
      H.startBatch(2, 2, 1); await wait(() => release);
      assert(H.project.queue.settings.globalPositivePrompt === rules.globalPositivePrompt, '队列未固定规则快照');
      H.pauseBatch(); await tick(); release(); await wait(() => !H.pumpActive);
      const queued = await saveProject(H.project);
      await reset(p); await H.load(queued); await tick();
      assert(H.project.queue.status === 'paused' && H.project.queue.settings.globalPositivePrompt === rules.globalPositivePrompt, '恢复队列丢失规则');
      handler = null; requests = []; H.resumeBatch(); await wait(() => !H.pumpActive && H.project.queue?.status === 'complete');
      assert(requests.length && requests.every((body) => body.globalNegativePrompt === rules.globalNegativePrompt), '续传规则改变');
      H.patch({ globalPositivePrompt: 'CHANGED' }); await tick(); assert(!H.project.queue, '修改规则保留旧队列');
      await reset({ ...p, ...rules, tiles: [] });
      const blob = await canvasBlob(canvas(128, 80)); await H.importBase(new File([blob], 'new.png', { type: 'image/png' })); await tick();
      assert(H.project.globalPositivePrompt === rules.globalPositivePrompt, '新底图丢失全局规则');
    });
    await test('碰撞格一笔批量提交可一次撤销和重做', async () => {
      await reset({ ...p, regions: [] });
      H.setCollisionCells([{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }]); await tick();
      assert(H.project.regions[0]?.cells.length === 3, '涂抹结果没有批量提交');
      H.undo(); await tick(); assert(!H.project.regions.some((region) => region.type === 'collision'), '一次撤销没有恢复整笔涂抹');
      H.redo(); await tick(); assert(H.project.regions.find((region) => region.type === 'collision')?.cells.length === 3, '重做没有恢复整笔涂抹');
    });
    await test('八方向补图：原有像素和透明像素逐字节保留', async () => {
      const base = await renderRect(p, H.assets, tileRect(p, p.tiles[0]), 'original');
      for (const d of DIRECTIONS) {
        const t = await generateTile(p, H.assets, { x: d.dx, y: d.dy }, { fetcher: mock });
        const composed = await renderRect({ ...p, tiles: [...p.tiles, t] }, H.assets, tileRect(p, p.tiles[0]), 'original'); equal(pixels(base), pixels(composed), `${d.id} 改动了原图`);
      }
    });
    await test('2×2 / 3×3 分段失败恢复：只提交剩余分段', async () => {
      for (const subdivisions of [2, 3]) {
        const parts = []; let count = 0;
        const failing = async (u, o) => { if (++count === 3) return Response.json({ error: '模拟中断' }, { status: 503 }); return mock(u, o); };
        try { await generateTile({ ...p, subdivisions }, H.assets, { x: 1, y: 0 }, { fetcher: failing, onPart: (items) => { parts.splice(0, parts.length, ...items); } }); } catch (e) { assert(e.message.includes('模拟中断'), e.message); }
        assert(parts.length === 2, '未保留完成分段'); const before = requests.length;
        await generateTile({ ...p, subdivisions }, H.assets, { x: 1, y: 0 }, { parts, fetcher: mock });
        assert(requests.length - before === subdivisions ** 2 - 2, '重做了已完成分段');
      }
    });
    await test('蒙版提取、透明物件与地面补全保护区', async () => {
      const raw = canvas(128, 80), rc = raw.getContext('2d'); rc.fillStyle = '#000'; rc.fillRect(0, 0, 128, 80); rc.fillStyle = '#fff'; rc.fillRect(0, 0, 64, 80);
      const rawId = await storeCanvas(raw, H.assets), extracted = await processedMatte(p.tiles[0], H.assets, rawId, 128, 0);
      const objects = canvas(128, 80); objects.getContext('2d').drawImage(await assetImage(extracted.objectsId, H.assets), 0, 0); assert(pixels(objects)[(20 * 128 + 90) * 4 + 3] === 0, '地面未变透明');
      const groundId = await generateGround(p, H.assets, p.tiles[0], extracted.maskId), ground = canvas(128, 80); ground.getContext('2d').drawImage(await assetImage(groundId, H.assets), 0, 0);
      const original = await renderRect(p, H.assets, tileRect(p, p.tiles[0]), 'original'); const a = pixels(original), b = pixels(ground);
      for (let y = 0; y < 80; y++) for (let x = 64; x < 128; x++) for (let k = 0; k < 4; k++) assert(a[(y * 128 + x) * 4 + k] === b[(y * 128 + x) * 4 + k], '补地面改动保护区');
    });
    await test('旧项目迁移只保存新版副本，ZIP 素材和负坐标往返恢复', async () => {
      const original = await H.assets.get(p.tiles[0].originalId), bytes = new Uint8Array(await original.arrayBuffer()); let binary = ''; for (const v of bytes) binary += String.fromCharCode(v);
      const old = { id: `legacy-${uid()}`, name: '旧版测试', tiles: [{ ...p.tiles[0], x: -1, y: 2, image: `data:image/png;base64,${btoa(binary)}` }], tileWidth: 128, tileHeight: 80, savedAt: Date.now() };
      await saveProject(old);
      const migrated = await migrateProject(old, H.assets); assert(migrated.id === null && migrated.overlapX === 0 && migrated.tiles[0].px === -128 && migrated.tiles[0].py === 160, '旧坐标不正确');
      const saved = await saveProject(migrated); assert(saved.id !== old.id, '覆盖了旧版 ID');
      assert((await readProject(old.id)).tiles[0].image === old.tiles[0].image, '旧版素材被改写');
      const zip = await exportProject(migrated, H.assets), reopened = await importProjectZip(new File([zip], 'map.zip'), H.assets); assert(reopened.tiles[0].px === -128 && reopened.tiles[0].py === 160, 'ZIP 坐标改变');
      equal(new Uint8Array(await (await H.assets.get(reopened.tiles[0].originalId)).arrayBuffer()), bytes, 'ZIP 素材改变');
    });
    await test('PNG / PSD / Unity ZIP 图层、坐标与区域完整', async () => {
      const q = { ...p, regions: [{ id: uid(), type: 'occlusion', name: '建筑遮挡', points: [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }], baseline: 40, sortOffset: 0, visible: true }] };
      const pack = await exportLayers(q, H.assets, true), files = unzipSync(new Uint8Array(await pack.arrayBuffer()));
      const instructions = new TextDecoder().decode(files['使用说明.txt']), importer = new TextDecoder().decode(files['Unity/Editor/FactoryMapImporter.cs']);
      assert(instructions.includes('Assets/Unity/Runtime') && instructions.includes('不要放成 Assets/Editor/Unity'), 'Unity 使用说明未提示运行时脚本目录');
      assert(importer.includes('ValidateRuntimeAssembly(typeof(FactoryMapRoot))') && importer.includes('AssemblyFlags.EditorAssembly'), 'Unity 导入器缺少编辑器程序集检查');
      const manifest = JSON.parse(new TextDecoder().decode(files['map.json'])); assert(manifest.images.some((i) => i.kind === 'occlusion') && files['Unity/Editor/FactoryMapImporter.cs'], 'Unity 内容缺失'); assert(manifest.tiles[0].col === 0, '图块逻辑列丢失');
      const image = canvas(128, 80), ctx = image.getContext('2d');
      for (const item of manifest.images) { const img = await loadImage(URL.createObjectURL(new Blob([files[item.file]], { type: 'image/png' }))); ctx.drawImage(img, item.x, item.y); }
      equal(pixels(image), pixels(await renderRect(q, H.assets, mapBounds(q))), '导出重组和画布不一致');
      const psd = readPsd(new Uint8Array(await (await exportPsd(q, H.assets)).arrayBuffer())); assert(psd.children.length === 3, 'PSD 图层缺失'); assert(psd.children[0].name === '建筑遮挡' && psd.children[2].name === '地面', 'PSD 图层上下顺序错误');
      equal(pixels(psd.canvas), pixels(await renderRect(q, H.assets, mapBounds(q))), 'PSD 合成不一致');
    });
    await test('工作台单块生成与四个服务、接纳和撤销', async () => {
      for (const provider of ['gemini', 'openai', 'qwen', 'kling']) {
        await reset({ ...p, provider }); await H.expand(DIRECTIONS.find((d) => d.id === 'e')); await tick();
        assert(H.pending && H.project.tiles.length === 1, `${provider} 未保留预览`); assert(requests[0].provider === provider, '发送了错误服务');
        H.accept(); await tick(); assert(H.project.tiles.length === 2, '接纳失败'); H.undo(); await tick(); assert(H.project.tiles.length === 1, '撤销失败');
      }
    });
    await test('风格参考生成初始图，以及局部重绘只修改选区', async () => {
      await reset({ ...p, tiles: [], styleAssetId: p.tiles[0].originalId }); await H.seed(); await tick();
      assert(H.project.tiles.length === 1 && H.project.tiles[0].width === 128 && H.project.tiles[0].height === 80, '初始图工作尺寸错误'); assert(requests[0].imageBase64 && requests[0].operation === 'seed', '风格参考未发送');
      assert(requests[0].prompt.includes('ALL FOUR CORNERS') && requests[0].prompt.includes('camera angle ONLY'), '初始图缺少矩形满幅构图要求');
      assert(requests[0].negativePrompt.includes('diamond-shaped map outline') && !requests[0].maskBase64 && !requests[0].grid, '初始图不应使用菱形网格遮罩');
      await reset(p); const original = await renderRect(p, H.assets, tileRect(p, p.tiles[0]), 'original');
      await H.retouch([{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }], 'repair'); await tick(); assert(H.pending?.mode === 'replace', '重绘没有预览');
      const image = await renderRect({ ...p, tiles: [H.pending.tile] }, H.assets, tileRect(p, p.tiles[0]), 'original'); const a = pixels(original), b = pixels(image);
      for (let y = 0; y < 80; y++) for (let x = 0; x < 128; x++) if (x < 10 || x >= 30 || y < 10 || y >= 30) for (let k = 0; k < 4; k++) assert(a[(y * 128 + x) * 4 + k] === b[(y * 128 + x) * 4 + k], '局部重绘修改了选区外');
      H.accept(); await tick(); assert(H.project.tiles[0].originalId !== p.tiles[0].originalId, '重绘接纳失败');
    });
    await test('参考或坐标变化后不能接纳过期预览', async () => {
      await reset(p); await H.expand(DIRECTIONS.find((d) => d.id === 'e')); await tick();
      H.apply({ ...H.project, overlapX: 20 }); await tick(); H.accept(); await tick(); assert(H.project.tiles.length === 1 && !H.pending, '过期预览被接纳');
    });
    await test('自动扩图失败暂停、继续与整批撤销', async () => {
      await reset(p); let count = 0;
      handler = (b) => ++count === 2 ? Response.json({ error: '模拟限流' }, { status: 429 }) : imageResponse(b);
      H.startBatch(3, 3, 1); await wait(() => H.project.queue?.status === 'paused' && !H.pumpActive, '失败后未暂停'); assert(H.project.tiles.length === 2, '完成结果未保留');
      handler = null; H.resumeBatch(); await wait(() => H.project.queue?.status === 'complete' && !H.pumpActive, '继续后未完成'); assert(H.project.tiles.length === 9, '未补齐矩形');
      H.undoBatch(); await tick(); assert(H.project.tiles.length === 1, '整批撤销未回到原图');
    });
    await test('暂停等待在途任务；停止后迟到响应不能改图', async () => {
      await reset(p); let release; handler = (b) => new Promise((resolve) => { release = () => resolve(imageResponse(b)); });
      H.startBatch(3, 3, 1); await wait(() => release); H.pauseBatch(); await tick(); release(); await wait(() => H.project.queue?.status === 'paused' && !H.pumpActive); assert(H.project.tiles.length === 2, '暂停未接纳在途完成块');
      H.stopBatch(); await tick(); await reset(p); release = null; handler = (b) => new Promise((resolve) => { release = () => resolve(imageResponse(b)); }); H.startBatch(3, 3, 1); await wait(() => release); H.stopBatch(); await tick(); release(); await tick(); await tick(); assert(H.project.tiles.length === 1, '迟到结果修改了已停止地图'); handler = null;
    });
    await test('三个并发任务补齐矩形且不重复目标', async () => {
      await reset(p); const releases = []; let held = 0;
      handler = (body) => held++ < 3 ? new Promise((resolve) => releases.push(() => resolve(imageResponse(body)))) : imageResponse(body);
      H.startBatch(3, 3, 3); await wait(() => releases.length === 3); assert(requests.length === 3, '并发限制失效'); releases.forEach((release) => release());
      await wait(() => H.project.queue?.status === 'complete' && !H.pumpActive); assert(H.project.tiles.length === 9 && new Set(H.project.tiles.map((t) => `${t.x},${t.y}`)).size === 9 && requests.length === 8, '并发导致重复图块或请求'); handler = null;
      H.undoBatch(); await tick();
    });
    await test('分层接纳、区域数据和自动草稿恢复保持暂停', async () => {
      await reset(p); await H.matte(true); await tick(); assert(H.selectedTile.layerDraft?.groundId, '分层流程未完成'); H.acceptLayers(); await tick(); assert(H.selectedTile.objectsId && H.selectedTile.groundId, '分层接纳丢失');
      H.setCollisionCells([{ x: 1, y: 2 }]); await tick(); assert(H.project.regions.find((region) => region.type === 'collision')?.cells.length === 1, '碰撞格未添加');
      const saved = normalizeProject({ ...H.project, queue: { status: 'running', tasks: [{ id: 'a', status: 'running' }] } }); assert(saved.queue.status === 'paused' && saved.queue.tasks[0].status === 'waiting', '恢复后仍自动运行');
    });
    await test('载入可灵角色、透明边距、替换和 IndexedDB / ZIP 完整往返；地图导出不烘焙角色', async () => {
      await reset(p); await H.loadScalePreset(); await tick();
      const s = H.project.scaleReference; assert(s.enabled && s.bounds.height === 96 && s.bounds.y === 2, '角色可见高度或锚点不正确');
      const beforeId = s.characterAssetId; await H.loadScalePreset(); await tick(); assert(H.project.scaleReference.characterAssetId === beforeId, '重复载入没有复用素材');
      const replacement = canvas(100, 180), rc = replacement.getContext('2d'); rc.fillStyle = '#901a25'; rc.fillRect(30, 40, 40, 100);
      const blob = await canvasBlob(replacement); assert((await characterImageBounds(blob)).height === 100, '透明边距计入可见高度');
      await H.importCharacter(new File([blob], '替换.png', { type: 'image/png' })); await tick();
      H.updateScaleReference({ position: { x: -20, y: 50 }, heightPx: 120 }); await tick();
      const saved = await saveProject(H.project), reopened = await migrateProject(await readProject(saved.id), new AssetStore());
      assert(reopened.scaleReference.heightPx === 120 && reopened.scaleReference.position.x === -20, '本机保存丢失参数');
      const zip = await exportProject(H.project, H.assets), files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
      assert(files[`assets/${H.project.scaleReference.characterAssetId}.png`], 'ZIP 没有角色素材');
      const portable = await importProjectZip(new File([zip], 'scale.zip'), H.assets);
      assert(portable.scaleReference.heightPx === 120 && portable.scaleReference.bounds.height === 100, 'ZIP 丢失角色配置');
      equal(new Uint8Array(await (await H.assets.get(portable.scaleReference.characterAssetId)).arrayBuffer()), new Uint8Array(await blob.arrayBuffer()), 'ZIP 角色图片改变');
      const png = await loadImage(URL.createObjectURL(await exportPng(H.project, H.assets))), rendered = canvas(png.width, png.height); rendered.getContext('2d').drawImage(png, 0, 0);
      equal(pixels(rendered), pixels(await renderRect(p, H.assets, mapBounds(p))), 'PNG 烘焙了角色');
      const psd = readPsd(new Uint8Array(await (await exportPsd(H.project, H.assets)).arrayBuffer())); equal(pixels(psd.canvas), pixels(rendered), 'PSD 烘焙了角色');
      const unity = unzipSync(new Uint8Array(await (await exportLayers(H.project, H.assets, true)).arrayBuffer()));
      assert(!Object.keys(unity).some((key) => key.includes(H.project.scaleReference.characterAssetId)), 'Unity 导出包含测试角色');
      const parts = await exportParts(H.project, H.assets); assert(!parts.manifest.scaleReference, '正式地图资源包含测试角色');
    });
    await test('四服务、2×2 / 3×3 分段及恢复均发送数值比例，不发送角色图片', async () => {
      for (const provider of ['openai', 'gemini', 'qwen', 'kling']) for (const subdivisions of [2, 3]) {
        await reset({ ...p, provider, subdivisions }); await H.loadScalePreset(); await tick();
        const s = H.project.scaleReference, parts = []; let count = 0; requests = [];
        try { await generateTile(H.project, H.assets, { x: 1, y: 0 }, { fetcher: async (u, o) => ++count === 2 ? Response.json({ error: '模拟中断' }, { status: 503 }) : mock(u, o), onPart: (items) => parts.splice(0, parts.length, ...items) }); } catch (e) { assert(e.message.includes('模拟中断'), e.message); }
        const before = requests.length; await generateTile(H.project, H.assets, { x: 1, y: 0 }, { parts, fetcher: mock });
        assert(requests.length - before === subdivisions ** 2 - 1, '恢复重做完成的分段');
        for (const body of requests) { assert(body.scaleReference.heightPx === 96 && body.scaleReference.frame.sourceWidth > 0, '缺少比例范围'); assert(!JSON.stringify(body).includes(s.characterAssetId), '发送了本机角色引用'); assert(body.prompt.includes('MAP_SCALE_REFERENCE'), '缺少比例提示词'); }
        requests = []; await H.retouch([{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }], '修复'); await tick(); assert(requests[0].scaleReference.heightPx === 96, '重绘未附加比例'); H.discard(); await tick();
        const initial = { ...H.project, tiles: [] }; await reset(initial); requests = []; await H.seed(); await tick(); assert(requests[0].scaleReference.heightPx === 96, '初始图未附加比例');
      }
    });
    await test('预览拖动不作废分段；修改数值规则清除旧分段和旧预览；自动队列固定比例快照', async () => {
      await reset(p); await H.loadScalePreset(); await tick();
      const s = H.project.scaleReference, signature = scaleGenerationFingerprint(H.project);
      H.apply({ ...H.project, work: { completedParts: [{ assetId: p.tiles[0].originalId }], status: 'paused' } }, false); await tick();
      H.updateScaleReference({ position: { x: 20, y: 30 }, visible: false }); await tick(); assert(H.project.work.completedParts.length === 1, '预览变化丢弃了分段');
      assert(scaleGenerationFingerprint(H.project) === signature, '预览位置影响生成签名');
      H.updateScaleReference({ heightPx: 112 }); await tick(); assert(!H.project.work, '比例修改复用了旧分段');
      await H.expand(DIRECTIONS.find((d) => d.id === 'e')); await tick(); assert(H.pending, '没有生成预览');
      H.updateScaleReference({ roadWidthPx: 128 }); await tick(); assert(!H.pending, '旧比例预览仍可接纳');
      await reset({ ...p, scaleReference: s }); let release; handler = (b) => new Promise((resolve) => { release = () => resolve(imageResponse(b)); });
      H.startBatch(2, 2, 1); await wait(() => release); assert(H.project.queue.settings.scaleReference.heightPx === 96 && H.project.queue.settings.grid.cellWidthPx === p.grid.cellWidthPx, '队列快照不完整');
      H.pauseBatch(); await tick(); release(); await wait(() => !H.pumpActive); H.stopBatch(); await tick(); H.updateScaleReference({ heightPx: 128 }); await tick(); assert(!H.project.queue, '数值变化后保留了旧队列分段'); handler = null;
      const work = { ...H.project, work: { completedParts: [{ assetId: p.tiles[0].originalId }], status: 'paused' } };
      const saved = await saveProject(work); await reset(p); await H.load(saved); await tick(); assert(H.project.work?.completedParts.length === 1, '重新打开时丢失可恢复分段');
    });
    await test('物件层只从蒙版提取原图像素，预览接纳与撤销正常', async () => {
      await reset({ ...p, provider: 'openai', prompt: 'FORBIDDEN_SCENE: 生成村庄建筑', negativePrompt: 'FORBIDDEN_NEGATIVE' });
      await H.matte(false); await tick();
      const draft = H.selectedTile.layerDraft;
      assert(requests.length === 1 && requests[0].operation === 'matte', '物件层不是由单次蒙版请求生成');
      assert(!requests[0].prompt.includes('FORBIDDEN_SCENE') && !requests[0].negativePrompt?.includes('FORBIDDEN_NEGATIVE'), '蒙版提示词混入场景描述');
      assert(draft.layerMode === 'mask' && draft.objectsId && validLayerPair(draft), '蒙版物件预览无效');
      const source = canvas(p.tileWidth, p.tileHeight), objects = canvas(p.tileWidth, p.tileHeight);
      source.getContext('2d').drawImage(await assetImage(p.tiles[0].originalId, H.assets), 0, 0);
      objects.getContext('2d').drawImage(await assetImage(draft.objectsId, H.assets), 0, 0);
      const src = pixels(source), out = pixels(objects), visible = (20 * p.tileWidth + 20) * 4, clear = (20 * p.tileWidth + 100) * 4;
      assert(out[visible + 3] > 0 && out[visible] === src[visible] && out[visible + 1] === src[visible + 1] && out[visible + 2] === src[visible + 2], '物件 RGB 被模型重绘');
      assert(out[clear + 3] === 0, '蒙版外没有透明');
      H.acceptLayers(); await tick(); assert(H.selectedTile.objectsId && !H.selectedTile.layerDraft, '接纳物件层失败');
      H.undo(); await tick(); assert(H.selectedTile.layerDraft?.objectsId, '接纳无法撤销');
      H.redo(); await tick(); assert(H.selectedTile.objectsId && !H.selectedTile.layerDraft, '重做没有恢复接纳');
      handler = null;
    });
    await test('1665×944 图层完整画幅映射到 3840×2176，Alpha 保留，错误画幅拒绝', async () => {
      const c = canvas(1665, 944), ctx = c.getContext('2d'); ctx.fillStyle = '#a03535'; ctx.fillRect(400, 200, 100, 200);
      const result = await importLayerImage(new File([await canvasBlob(c)], '物件层.png', { type: 'image/png' }), H.assets, { width: 3840, height: 2176 }, 'objects');
      assert(result.valid && result.width === 1665, '导入丢失透明或原尺寸'); const img = await assetImage(result.assetId, H.assets); assert(img.width === 3840 && img.height === 2176, '未映射到项目坐标');
      const raw = canvas(3840, 2176); raw.getContext('2d').drawImage(img, 0, 0); assert(layerAlphaValid(raw, 'objects'), '透明丢失');
      let rejected = false; try { await importLayerImage(new File([await canvasBlob(canvas(100, 100))], '错.png', { type: 'image/png' }), H.assets, { width: 3840, height: 2176 }, 'objects'); } catch (e) { rejected = /宽高比例/.test(e.message); } assert(rejected, '不同画幅被拉伸');
      await reset({ ...p, tileWidth: 3840, tileHeight: 2176, tiles: [{ ...p.tiles[0], width: 3840, height: 2176 }] }); await H.importLayer(new File([await canvasBlob(c)], '物件层.png', { type: 'image/png' }), 'objects'); await tick(); assert(H.selectedTile.layerDraft?.objectsValid, '导入未进入预览');
    });
    await test('Gemini 3840×2176 参考图保留逐像素纹理，自动档位与原始/对齐结果单次保存', async () => {
      const source = canvas(3840, 2176), sc = source.getContext('2d');
      sc.fillStyle = '#74674e'; sc.fillRect(0, 0, source.width, source.height);
      for (let x = 0; x < source.width; x += 7) { sc.fillStyle = x % 2 ? '#a19781' : '#352c20'; sc.fillRect(x, 0, 1, source.height); }
      sc.fillStyle = '#09f'; sc.fillRect(3, 4, 2, 2); sc.fillStyle = '#f70'; sc.fillRect(3835, 2171, 2, 2);
      const id = await storeCanvas(source, H.assets), large = { ...p, provider: 'gemini', groundResolution: 'auto', tileWidth: 3840, tileHeight: 2176, layerPrompts: { ground: 'CUSTOM_KEEP_DETAIL' }, tiles: [{ ...p.tiles[0], width: 3840, height: 2176, originalId: id }] };
      await reset(large);
      handler = async (body) => {
        const frame = geminiGroundFrame(3840, 2176);
        assert(body.width === frame.width && body.height === frame.height, '参考图仍被缩小');
        assert(body.resolution === 'auto' && !body.maskBase64 && !body.markedGuide, '质量或整图单次流程错误');
        assert(body.prompt === 'CUSTOM_KEEP_DETAIL' && body.layerPrompt === 'CUSTOM_KEEP_DETAIL', '自定义提示词被改变');
        return Response.json({ imageBase64: body.imageBase64, mimeType: 'image/png', model: DEFAULT_GEMINI_MODEL, generation: resolveGeminiGround(DEFAULT_GEMINI_MODEL, body.resolution, body.width, body.height) });
      };
      await H.generateLayer('ground'); await tick();
      const draft = H.selectedTile.layerDraft, info = draft.groundGeneration;
      assert(requests.length === 1 && info.resolvedResolution === '4K' && draft.groundRawAssetId, '重复请求、档位错误或原始结果未保存');
      assert(info.sourceWidth === 3840 && info.referenceWidth === 3872 && info.actualWidth === 3872 && info.alignedWidth === 3840 && !info.upscaled, '尺寸元数据错误');
      const fitted = canvas(3840, 2176); fitted.getContext('2d').drawImage(await assetImage(draft.groundId, H.assets), 0, 0);
      const a = pixels(source), b = pixels(fitted); for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `纹理像素 ${i} 改变`);
      const sentBytes = Uint8Array.from(atob(requests[0].imageBase64), (c) => c.charCodeAt(0));
      equal(sentBytes, new Uint8Array(await (await H.assets.get(draft.groundRawAssetId)).arrayBuffer()), '服务原始结果被重新编码');
      H.undo(); await tick(); assert(!H.selectedTile.layerDraft, '生成结果不能撤销'); H.redo(); await tick(); assert(H.selectedTile.layerDraft.groundRawAssetId === draft.groundRawAssetId, '重做丢失原始素材');
      const zip = await exportProject(H.project, H.assets), restored = await importProjectZip(new File([zip], 'ground-quality.zip'), H.assets);
      assert(restored.groundResolution === 'auto' && restored.tiles[0].layerDraft.groundGeneration.resolvedResolution === '4K', '项目 ZIP 丢失质量设置或元数据');
      equal(sentBytes, new Uint8Array(await (await H.assets.get(restored.tiles[0].layerDraft.groundRawAssetId)).arrayBuffer()), '项目 ZIP 丢失原始结果');
      handler = null;
    });
    await test('Gemini 手动档位、低清返回放大提示及失败不重试', async () => {
      await reset({ ...p, provider: 'gemini', groundResolution: '2K' });
      handler = (body) => {
        assert(body.resolution === '2K', '手动档位未传递');
        const c = canvas(32, 18); c.getContext('2d').fillRect(0, 0, 32, 18);
        return Response.json({ imageBase64: c.toDataURL().split(',')[1], mimeType: 'image/png', model: DEFAULT_GEMINI_MODEL, generation: { resolvedResolution: '2K' } });
      };
      await H.generateLayer('ground'); await tick();
      assert(requests.length === 1 && H.selectedTile.layerDraft.groundGeneration.upscaled, '未检测低清放大');
      const panel = document.querySelector('#ground-controls');
      assert(panel.textContent.includes('实际返回尺寸不足') && panel.textContent.includes('下载服务原始结果') && panel.textContent.includes('下载对齐地图版本'), '面板尺寸提示或下载入口缺失');
      handler = () => Response.json({ error: '模拟 4K 失败' }, { status: 429 });
      H.patch({ groundResolution: '4K' }); await tick(); await H.generateLayer('ground'); await tick();
      assert(requests.length === 2 && H.error.includes('模拟 4K 失败'), '失败后重试或没有显示错误');
      assert(H.selectedTile.layerDraft.groundGeneration.resolvedResolution === '2K', '失败覆盖上次结果');
      handler = null;
    });
    await test('Gemini 通用 1K/2K/4K 穿过初始图、扩图、重绘和分层请求，高档位参考图不缩小', async () => {
      await reset({ ...p, provider: 'gemini' });
      const source = canvas(2048, 1152); source.getContext('2d').fillRect(0, 0, 2048, 1152);
      const before = requests.length;
      for (const resolution of ['1K', '2K', '4K']) for (const operation of ['seed', 'expand', 'retouch', 'objects', 'matte']) {
        await requestImage({ ...p, provider: 'gemini', resolution }, H.assets, operation, { image: source });
        const body = requests.at(-1); assert(body.resolution === resolution && body.operation === operation, '通用尺寸未传到请求');
        assert(resolution === '1K' ? body.width <= 1536 : body.width >= 2048, '高档位参考图仍被缩至 1536');
      }
      assert(requests.length - before === 15, '通用尺寸产生额外请求');
    });
    await test('已有物件本地清理：封闭暗紫孔洞、原图同色保护、备份/撤销和 ZIP 恢复，无生图请求', async () => {
      const original = canvas(128, 80), oc = original.getContext('2d'); oc.fillStyle = '#635e42'; oc.fillRect(0, 0, 128, 80); oc.fillStyle = '#9834b0'; oc.fillRect(45, 25, 10, 10);
      const objects = canvas(128, 80), ctx = objects.getContext('2d'); ctx.fillStyle = '#385936'; ctx.fillRect(30, 15, 60, 45); ctx.fillStyle = '#9834b0'; ctx.fillRect(45, 25, 10, 10); ctx.fillStyle = '#550866'; ctx.fillRect(60, 25, 8, 8);
      const originalId = await storeCanvas(original, H.assets), objectsId = await storeCanvas(objects, H.assets), groundId = p.tiles[0].originalId;
      const draft = { layerMode: 'direct', objectsId, groundId, objectsValid: true, groundValid: true, objectsGeneration: { model: DEFAULT_GEMINI_MODEL } };
      await reset({ ...p, provider: 'gemini', tiles: [{ ...p.tiles[0], originalId, layerDraft: draft }] });
      assert(!validLayerPair(H.selectedTile.layerDraft), '旧层只检查 Alpha 就允许接纳');
      await H.cleanObjects(); await tick(); assert(requests.length === 0, '本地修复调用了生图');
      const next = H.selectedTile.layerDraft; assert(validLayerPair(next) && next.objectsBeforeCleanupAssetId === objectsId && next.groundId === groundId, '清理丢失地面或原素材备份');
      const clean = canvas(128, 80); clean.getContext('2d').drawImage(await assetImage(next.objectsId, H.assets), 0, 0); const a = pixels(clean);
      assert(a[(27 * 128 + 62) * 4 + 3] === 0, '封闭暗紫孔洞未透明'); assert(a[(27 * 128 + 47) * 4 + 3] === 255, '原图紫色物件受损');
      H.undo(); await tick(); assert(H.selectedTile.layerDraft.objectsId === objectsId, '清理不能撤销'); H.redo(); await tick();
      const zip = await exportProject(H.project, H.assets), restored = await importProjectZip(new File([zip], 'matte-repair.zip'), H.assets);
      assert(restored.tiles[0].layerDraft.objectsBeforeCleanupAssetId && validLayerPair(restored.tiles[0].layerDraft), 'ZIP 丢失清理备份或检查状态');
    });
    results.textContent += `\n全部通过：${successful} 组浏览器验收。\n`;
    document.body.dataset.result = 'passed';
  } catch (e) { document.body.dataset.result = 'failed'; console.error(e); }
  finally { window.fetch = nativeFetch; handler = null; document.querySelector('#run').disabled = false; }
};
document.querySelector('#fixture').onclick = async () => {
  await wait(() => H?.ready); const p = await fixture();
  const terrain = canvas(512, 320), ctx = terrain.getContext('2d'); ctx.fillStyle = '#aebc89'; ctx.fillRect(0, 0, 512, 320); ctx.fillStyle = '#ced5a8'; ctx.fillRect(0, 140, 512, 45);
  ctx.fillStyle = '#d6cb9c'; ctx.beginPath(); ctx.moveTo(0, 280); ctx.lineTo(512, 15); ctx.lineTo(512, 50); ctx.lineTo(0, 315); ctx.fill();
  const terrainId = await storeCanvas(terrain, H.assets), image = canvas(512, 320); image.getContext('2d').drawImage(terrain, 0, 0);
  const objects = canvas(512, 320), oc = objects.getContext('2d');
  oc.fillStyle = '#5e7958'; for (let i = 0; i < 20; i++) { oc.beginPath(); oc.arc((i * 73) % 510, (i * 117) % 310, 9, 0, Math.PI * 2); oc.fill(); }
  oc.fillStyle = '#647269'; oc.fillRect(200, 100, 100, 75); oc.fillStyle = '#9ba997'; oc.beginPath(); oc.moveTo(180, 100); oc.lineTo(250, 60); oc.lineTo(320, 100); oc.closePath(); oc.fill(); image.getContext('2d').drawImage(objects, 0, 0);
  const originalId = await storeCanvas(image, H.assets), objectsId = await storeCanvas(objects, H.assets);
  p.tileWidth = 512; p.tileHeight = 320; p.tiles = [];
  for (const [x, y] of [[0, 0], [1, 0], [0, 1]]) p.tiles.push({ id: uid(), x, y, width: 512, height: 320, originalId, groundId: terrainId, objectsId, kind: x || y ? 'generated' : 'base', name: `样例 ${x},${y}` });
  p.regions = [{ id: uid(), type: 'occlusion', name: '仓库遮挡', points: [{ x: 180, y: 60 }, { x: 320, y: 60 }, { x: 320, y: 175 }, { x: 180, y: 175 }], baseline: 175, sortOffset: 0, visible: true }];
  download(await exportProject(p, H.assets), '地图验收样例.zip');
};
document.querySelector('#scale-fixture').onclick = async () => {
  await wait(() => H?.ready);
  const p = newProject(), c = canvas(1200, 800), ctx = c.getContext('2d');
  ctx.fillStyle = '#9ca47b'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#aab38c'; for (let y = 0; y < 800; y += 40) for (let x = y % 80; x < 1200; x += 80) ctx.fillRect(x, y, 37, 19);
  ctx.fillStyle = '#c4b38e'; ctx.fillRect(0, 540, 1200, 96);
  const rectangles = [[160, 120, 240, 220], [160, 340, 88, 40], [312, 340, 88, 40], [780, 300, 88, 60], [892, 300, 108, 60], [780, 460, 68, 60], [912, 460, 88, 60]];
  ctx.fillStyle = '#625e53'; rectangles.forEach((r) => ctx.fillRect(...r));
  ctx.fillStyle = '#6b2830'; ctx.beginPath(); ctx.moveTo(140, 120); ctx.lineTo(280, 40); ctx.lineTo(420, 120); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#382c27'; ctx.fillRect(248, 260, 64, 120);
  ctx.fillStyle = '#fff8df'; ctx.font = '18px system-ui'; ctx.fillText('64 × 120 px door', 170, 410); ctx.fillText('24 px gap', 810, 285); ctx.fillText('64 px passage', 800, 445); ctx.fillText('96 px road', 1040, 595);
  const originalId = await storeCanvas(c, H.assets);
  p.name = '角色比例与通道校准'; p.tileWidth = 1200; p.tileHeight = 800; p.grid = { ...p.grid, width: 12, height: 8, visible: false };
  p.tiles = [{ id: uid(), kind: 'base', x: 0, y: 0, width: 1200, height: 800, originalId, name: '校准底图' }];
  p.regions = rectangles.map(([x, y, width, height], index) => ({ id: uid(), type: 'collision', name: `测试墙壁 ${index + 1}`, visible: true, points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], baseline: y + height, sortOffset: 0 }));
  await reset(p); await H.loadScalePreset(); await tick(); H.updateScaleReference({ position: { x: 600, y: 600 } }); await tick();
  await saveProject(H.project, true);
  results.textContent = '校准样例已保存到此独立来源。';
  const link = document.createElement('a'); link.href = '/map-expansion'; link.textContent = '打开比例试走样例'; results.append(document.createElement('br'), link);
};

document.querySelector('#reference-fixture').onclick = async () => {
  await wait(() => H?.ready);
  const image = canvas(320, 180), ctx = image.getContext('2d');
  ctx.fillStyle = '#3b4542'; ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = '#786750'; ctx.fillRect(30, 90, 115, 65);
  ctx.fillStyle = '#394653'; ctx.beginPath(); ctx.moveTo(15, 90); ctx.lineTo(85, 32); ctx.lineTo(160, 90); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#bd8c44'; ctx.fillRect(60, 112, 16, 20); ctx.fillRect(104, 112, 16, 20);
  ctx.fillStyle = '#3e342b'; ctx.fillRect(245, 105, 15, 55);
  ctx.fillStyle = '#65704a'; ctx.beginPath(); ctx.arc(252, 85, 43, 0, Math.PI * 2); ctx.fill();
  const styleAssetId = await storeCanvas(image, H.assets), p = { ...newProject(), tileWidth: 1280, tileHeight: 720, name: '参考用途界面验收', styleAssetId };
  await saveProject(p, true); results.textContent = '参考图样例已准备。仅测试本机界面，不发送图片到AI。';
};
