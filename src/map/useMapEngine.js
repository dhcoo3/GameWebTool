import { normalizeReferenceSettings } from './reference.js';
import { referenceSample } from './referenceImages.js';
import { regionPolygon } from './regionDrawing.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { batchTargets, DRAFT_ID, keyOf, newProject, readyTasks, reflow, tileRect, uid } from './core.js';
import { AssetStore, listProjects, migrateProject, readProject, saveProject } from './storage.js';
import { assetImage, canvas, cleanObjectMatte, generateGround, groundInputs, previewExpansion, previewRetouch, generateMatteTile, generateTile, importImage, processedMatte, requestImage, retouchTile, storeCanvas } from './images.js';
import { importProjectZip } from './exports.js';
import { normalizeScaleReference, scaleGenerationFingerprint } from './scale.js';
import { characterImageBounds } from './characterImage.js';
import { rebuildLayer, importLayerImage, layerAlphaValid, validLayerPair } from './layers.js';
import { matteValid } from './chromaKey.js';
import { supportsObjectLayers } from './layerCapabilities.js';

const globalRulesStamp = (p) => JSON.stringify([p.globalPositivePrompt || '', p.globalNegativePrompt || '']);
const sourceStamp = (p) => JSON.stringify([p.overlapX, p.overlapY, p.tiles.map((t) => [t.id, t.originalId]), scaleGenerationFingerprint(p), globalRulesStamp(p)]);

export default function useMapEngine({ config, serverOffline, onOpenSettings, notify }) {
  const assets = useMemo(() => new AssetStore(), []);
  const [project, setProject] = useState(newProject), ref = useRef(project);
  const [busy, setBusy] = useState(''), [ready, setReady] = useState(false), [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(''), [selectedRegionId, setSelectedRegionId] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0), history = useRef({ past: [], future: [] });
  const [pumpActive, setPumpActive] = useState(false), pump = useRef(false);
  const [layerPumpActive, setLayerPumpActive] = useState(false), layerPump = useRef(false);
  const epoch = useRef(0), layerEpoch = useRef(0), controller = useRef(null), batchControllers = useRef(new Map()), layerControllers = useRef(new Map()), mounted = useRef(true);
  const restored = useRef(false), builtinCharacter = useRef(null);
  const selectedTile = project.tiles.find((t) => t.id === selectedId) || project.tiles[0] || null;
  const selectedRegion = project.regions.find((r) => r.id === selectedRegionId) || null;
  const queueLocked = ['running', 'paused', 'pausing'].includes(project.queue?.status);
  const layerQueueLocked = ['running', 'paused', 'pausing'].includes(project.layerQueue?.status);
  const locked = !ready || Boolean(busy) || queueLocked || layerQueueLocked || pumpActive || layerPumpActive;
  const pushHistory = useCallback((value) => { history.current.past = [...history.current.past.slice(-39), value]; history.current.future = []; setHistoryVersion((v) => v + 1); }, []);
  const apply = useCallback((change, record = true) => {
    if (!mounted.current) return;
    const current = ref.current; let next = typeof change === 'function' ? change(current) : change;
    // Edits invalidate unfinished work; opening a saved project preserves its resumable snapshot.
    if (current.tiles === next.tiles && (scaleGenerationFingerprint(current) !== scaleGenerationFingerprint(next) || globalRulesStamp(current) !== globalRulesStamp(next))) { next = { ...next, work: null, queue: null }; setPending(null); }
    if (current === next) return;
    if (record) pushHistory(current);
    ref.current = next; setProject(next);
  }, [pushHistory]);
  assets.onRequest = (event) => {
    if (!mounted.current || event.taskId !== assets.requestTaskId) return;
    const previous = ref.current.requestLog?.id === event.taskId ? ref.current.requestLog : { id: event.taskId || uid(), name: assets.requestTaskName || '地图生成', startedAt: Date.now(), requests: [] };
    const existing = previous.requests.find((r) => r.requestId === event.requestId);
    const record = { ...existing, ...event };
    const trace = { ...previous, requests: existing ? previous.requests.map((r) => r.requestId === event.requestId ? record : r) : [...previous.requests, record] };
    assets.activeTrace = trace;
    apply((p) => ({ ...p, requestLog: trace }), false);
  };
  const patch = (value, record = false) => { if (!locked) apply((p) => ({ ...p, ...value }), record); };
  useEffect(() => {
    mounted.current = true; let cancelled = false;
    readProject(DRAFT_ID).then(async (saved) => {
      if (!saved) return;
      const p = await migrateProject(saved, assets);
      if (!cancelled) { ref.current = p; setProject(p); }
    }).catch((e) => !cancelled && notify(`恢复草稿失败：${e.message}`)).finally(() => { if (!cancelled) { restored.current = true; setReady(true); } });
    return () => { cancelled = true; if (restored.current) saveProject(ref.current, true).catch(() => {}); mounted.current = false; epoch.current++; layerEpoch.current++; controller.current?.abort(); for (const c of batchControllers.current.values()) c.abort(); for (const c of layerControllers.current.values()) c.abort(); assets.release(); };
  }, [assets, notify]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => saveProject(project, true).catch((e) => notify(`草稿保存失败：${e.message}`)), 700);
    return () => clearTimeout(timer);
  }, [project, ready, notify]);
  const guardService = () => {
    if (serverOffline) { notify('本机 API 服务未启动，请先启动 npm run dev。'); return false; }
    if (!config.configured[ref.current.provider]) { notify('请先配置当前图像服务的 API key。'); onOpenSettings(); return false; }
    return true;
  };
  async function run(label, action, needsService = true) {
    if (locked || controller.current || pump.current || layerPump.current || (needsService && !guardService())) return;
    assets.activeTrace = null;
    if (needsService) { assets.requestTaskId = uid(); assets.requestTaskName = label; assets.activeTrace = null; }
    const token = ++epoch.current, abort = new AbortController(); controller.current = abort; setBusy(label); setError('');
    const current = () => mounted.current && token === epoch.current && !abort.signal.aborted;
    try { await action(ref.current, abort.signal, current); }
    catch (e) { if (current() && e.name !== 'AbortError') { setError(e.message || '操作失败。'); notify(e.message || '操作失败。'); } }
    finally { if (token === epoch.current && mounted.current) { if (assets.activeTrace && assets.activeTrace.id === assets.requestTaskId) apply((p) => ({ ...p, requestLog: assets.activeTrace }), false); setBusy(''); controller.current = null; } }
  }
  const cancel = () => { epoch.current++; controller.current?.abort(); controller.current = null; if (ref.current.work) apply((p) => ({ ...p, work: { ...p.work, status: 'paused' } }), false); setBusy(''); notify('已停止；已完成的分段已保留。'); };
  const save = async () => {
    if (!ready) return;
    try { const saved = await saveProject(ref.current); apply((p) => ({ ...p, id: saved.id, savedAt: saved.savedAt }), false); notify('地图项目已保存到本机。'); }
    catch (e) { notify(`保存失败：${e.message}`); }
  };
  const load = async (saved) => {
    if (locked) return;
    assets.requestTaskId = null; assets.activeTrace = null;
    try { const next = await migrateProject(saved, assets); pushHistory(ref.current); apply(next, false); setPending(null); setSelectedId(next.tiles[0]?.id || ''); setSelectedRegionId(''); notify(saved.schemaVersion === 2 ? '项目已打开。' : '旧地图已作为升级副本打开，原项目保留。'); }
    catch (e) { notify(`打开失败：${e.message}`); }
  };
  const createNew = () => {
    if (locked || (ref.current.tiles.length && !window.confirm('新建地图？当前内容已自动保存为草稿，也可以撤销。'))) return;
    assets.requestTaskId = null; assets.activeTrace = null;
    apply(newProject()); setPending(null); setSelectedId(''); setSelectedRegionId('');
  };
  const importBase = (file, replace = false) => run('正在导入图片', async (p, signal, current) => {
    if (!file) return;
    if (!replace && p.tiles.length && !window.confirm('导入新底图并替换当前画布？此操作可以撤销。')) return;
    const image = await importImage(file, assets);
    if (!current()) return;
    if (replace && selectedTile) {
      const fitted = canvas(p.tileWidth, p.tileHeight); fitted.getContext('2d').drawImage(await assetImage(image.assetId, assets), 0, 0, fitted.width, fitted.height);
      const originalId = await storeCanvas(fitted, assets);
      if (current()) { apply((v) => ({ ...v, work: null, tiles: v.tiles.map((t) => t.id === selectedTile.id ? { ...t, originalId, groundId: '', objectsId: '', maskId: '', rawMaskId: '', layerDraft: null } : t) })); setPending(null); }
    } else {
      const tile = { id: uid(), x: 0, y: 0, px: 0, py: 0, width: image.width, height: image.height, originalId: image.assetId, name: file.name, kind: 'base', addedAt: Date.now() };
      apply({ ...newProject(), grid: { ...p.grid }, pixelsPerUnit: p.pixelsPerUnit, scaleReference: { ...p.scaleReference, position: null }, name: file.name.replace(/\.[^.]+$/, ''), provider: p.provider, prompt: p.prompt, negativePrompt: p.negativePrompt, globalPositivePrompt: p.globalPositivePrompt, globalNegativePrompt: p.globalNegativePrompt, styleAssetId: p.styleAssetId, referenceSettings: normalizeReferenceSettings(p.referenceSettings), tiles: [tile], tileWidth: image.width, tileHeight: image.height }); setSelectedId(tile.id); setPending(null);
    }
    notify('图片已导入，透明通道已保留。');
  }, false);
  const updateScaleReference = (change, record = false) => {
    const visualOnly = Object.keys(change).every((key) => ['position', 'visible'].includes(key));
    if (!locked || visualOnly) apply((current) => ({ ...current, scaleReference: normalizeScaleReference({ ...current.scaleReference, ...change }) }), record);
  };
  const loadScalePreset = () => run('正在载入临时角色', async (p, signal, current) => {
    if (!builtinCharacter.current) {
      const response = await fetch('/assets/scale-reference/preset.json', { signal });
      if (!response.ok) throw new Error('临时角色参数未找到。');
      const preset = await response.json();
      const imageResponse = await fetch('/assets/scale-reference/character.png', { signal });
      if (!imageResponse.ok) throw new Error('临时角色图片未找到。');
      const blob = await imageResponse.blob(), bounds = await characterImageBounds(blob);
      builtinCharacter.current = { ...preset.scaleReference, characterAssetId: await assets.put(blob), bounds };
    }
    if (current()) apply((value) => ({ ...value, scaleReference: normalizeScaleReference({ ...value.scaleReference, characterAssetId: builtinCharacter.current.characterAssetId, bounds: builtinCharacter.current.bounds, feetX: .5, feetY: 1, visible: true }) }));
    if (current()) notify('临时角色已载入，当前标尺与物件尺寸保持不变。');
  }, false);
  const importCharacter = (file) => run('正在读取角色图片', async (p, signal, current) => {
    if (!file) return;
    const bounds = await characterImageBounds(file), characterAssetId = await assets.put(file);
    if (current()) apply((value) => ({ ...value, scaleReference: normalizeScaleReference({ ...value.scaleReference, visible: true, characterAssetId, bounds, feetX: .5, feetY: 1 }) }));
    if (current()) notify('角色已替换，透明边距不会影响可见高度。');
  }, false);
  const importStyle = (file) => run('正在读取参考图', async (p, signal, current) => { const image = await importImage(file, assets, 1536); if (current()) apply((v) => ({ ...v, styleAssetId: image.assetId, referenceSettings: { ...normalizeReferenceSettings(v.referenceSettings), crop: null } }), false); }, false);
  const importZip = (file) => run('正在导入项目', async (p, signal, current) => { const value = await importProjectZip(file, assets); if (current()) { apply(value); setPending(null); setSelectedId(value.tiles[0]?.id || ''); notify('完整地图项目已恢复。'); } }, false);
  const extractStyle = () => run('正在提炼参考图风格', async (p, signal, current) => {
    const settings = normalizeReferenceSettings(p.referenceSettings);
    if (!config.configured[settings.provider]) { onOpenSettings(); throw new Error('请先配置所选提示词服务的 API key。'); }
    const sample = await referenceSample({ ...p, referenceSettings: { ...settings, mode: 'style' } }, assets);
    if (!sample) throw new Error('请先上传参考图。');
    const response = await fetch('/api/map/style', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: settings.provider, referenceImageBase64: sample.toDataURL('image/png').split(',')[1], referenceMimeType: 'image/png' }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '风格提炼失败。');
    if (current()) apply((v) => ({ ...v, referenceSettings: { ...normalizeReferenceSettings(v.referenceSettings), positive: result.prompt, negative: result.negativePrompt, source: { sourceAssetId: p.styleAssetId, crop: settings.crop, model: result.model } } }));
    if (current()) notify('风格文字已提炼，可编辑；切换到“文字风格”后用于生图。');
  }, false);
  const previewPrompts = async (operation, { direction, points, prompt } = {}) => {
    const p = ref.current;
    if (operation === 'seed') return [await requestImage(p, assets, 'seed', { previewOnly: true })];
    if (!selectedTile) throw new Error('请先选择地图块。');
    if (operation === 'expand') {
      if (!direction) throw new Error('请选择扩图方向。');
      return previewExpansion(p, assets, { x: selectedTile.x + direction.dx, y: selectedTile.y + direction.dy });
    }
    if (operation === 'retouch') {
      if (!points || points.length < 3) throw new Error('请先框选重绘区域。');
      return [await previewRetouch(p, assets, selectedTile, points, prompt)];
    }
    const source = canvas(selectedTile.width, selectedTile.height); source.getContext('2d').drawImage(await assetImage(selectedTile.originalId, assets), 0, 0);
    const maskId = selectedTile.layerDraft?.maskId || selectedTile.maskId;
    if (operation === 'ground-mask') {
      if (!maskId) throw new Error('请先生成或导入物件蒙版。');
      return [await requestImage(p, assets, 'ground', { ...await groundInputs(assets, selectedTile, maskId), previewOnly: true })];
    }
    return [await requestImage(p, assets, operation, { image: source, previewOnly: true })];
  };
  const seed = () => run('正在生成初始地图', async (p, signal, current) => {
    if (p.tiles.length && !window.confirm('生成初始地图将替换当前画布，是否继续？')) return;
    const result = await requestImage(p, assets, 'seed', { signal }); const originalId = await storeCanvas(result.canvas, assets);
    if (!current()) return;
    const tile = { id: uid(), x: 0, y: 0, px: 0, py: 0, width: p.tileWidth, height: p.tileHeight, originalId, name: '初始地图', kind: 'base', addedAt: Date.now(), actualWidth: result.actualWidth, actualHeight: result.actualHeight, model: result.model };
    apply((value) => ({ ...p, id: null, scaleReference: { ...p.scaleReference, position: value.scaleReference.position, visible: value.scaleReference.visible }, tiles: [tile], regions: [], work: null, queue: null, layerQueue: null })); setSelectedId(tile.id); setPending(null); notify('初始地图已生成。');
  });
  const expand = (direction) => run('正在生成相邻地图', async (p, signal, current) => {
    if (!selectedTile) throw new Error('请先选择地图块。');
    const target = { x: selectedTile.x + direction.dx, y: selectedTile.y + direction.dy };
    if (p.tiles.some((t) => t.x === target.x && t.y === target.y)) throw new Error('目标位置已有图块。');
    const signature = JSON.stringify([target, p.tiles.map((t) => [t.id, t.originalId]), p.overlapX, p.overlapY, p.subdivisions, p.provider, p.resolution, p.prompt, p.negativePrompt, scaleGenerationFingerprint(p), globalRulesStamp(p)]);
    const matching = p.work?.signature === signature;
    if (matching && p.work.traceId) assets.requestTaskId = p.work.traceId;
    const traceId = assets.requestTaskId;
    const parts = matching ? p.work.completedParts : [];
    apply((v) => ({ ...v, work: { signature, traceId, target, completedParts: parts, status: 'running' } }), false);
    try {
      const tile = await generateTile(p, assets, target, { parts, signal, onPart: (completedParts) => { if (current()) apply((v) => ({ ...v, work: { signature, traceId, target, completedParts, status: 'running' } }), false); } });
      if (current()) { setPending({ tile, mode: 'add', sourceStamp: sourceStamp(p) }); apply((v) => ({ ...v, work: { ...v.work, status: 'complete' } }), false); notify('生成结果已就绪，请检查后接纳。'); }
    } catch (e) { if (current()) apply((v) => ({ ...v, work: { ...v.work, status: 'paused' } }), false); throw e; }
  });
  const accept = () => {
    if (!pending || busy || queueLocked) return;
    const { tile, mode } = pending;
    if (pending.sourceStamp !== sourceStamp(ref.current)) { setPending(null); return notify('参考图或地图位置已变更，请重新生成预览。'); }
    if (mode === 'add' && ref.current.tiles.some((t) => t.x === tile.x && t.y === tile.y)) return notify('目标已被占用。');
    apply((p) => ({ ...p, tiles: mode === 'replace' ? p.tiles.map((t) => t.id === tile.id ? tile : t) : [...p.tiles, tile], work: null })); setSelectedId(tile.id); setPending(null); notify('地图块已接纳。');
  };
  const discard = () => { if (busy) return; setPending(null); apply((p) => ({ ...p, work: null }), false); };
  const changeOverlap = (x, y) => { if (!locked) { apply((p) => ({ ...reflow(p, x, y), work: null })); setPending(null); } };
  const changeTile = (id, change, record = true) => apply((p) => ({ ...p, tiles: p.tiles.map((t) => t.id === id ? { ...t, ...change } : t) }), record);
  const matte = (withGround = false) => run(withGround ? '正在自动分层（蒙版 → 物件 → 地面）' : '正在生成物件蒙版', async (p, signal, current) => {
    if (!selectedTile) throw new Error('请先选择地图块。');
    const result = await generateMatteTile(p, assets, selectedTile, { divisions: 1, signal }); const rawMaskId = await storeCanvas(result.rawMask, assets);
    const processed = await processedMatte(selectedTile, assets, rawMaskId), draft = { ...processed, layerMode: 'mask', rawMaskId, threshold: 128, feather: 1, groundId: '' };
    if (!current()) return; changeTile(selectedTile.id, { layerDraft: draft });
    if (withGround) { const groundId = await generateGround(p, assets, selectedTile, draft.maskId, signal); if (current()) changeTile(selectedTile.id, { layerDraft: { ...draft, groundId } }, false); }
    if (current()) notify('分层预览已更新，请检查轮廓后接纳。');
  });
  const ground = () => run('正在补全物件下方的地面', async (p, signal, current) => {
    const draft = selectedTile?.layerDraft || selectedTile, maskId = draft?.maskId || selectedTile?.maskId;
    if (!maskId) throw new Error('请先生成或编辑物件蒙版。');
    const groundId = await generateGround(p, assets, selectedTile, maskId, signal);
    if (current()) changeTile(selectedTile.id, { layerDraft: { ...draft, layerMode: draft.layerMode || 'mask', groundId } });
  });
  const editMatte = (rawCanvas, threshold, feather) => run('正在更新蒙版', async (p, signal, current) => {
    if (!selectedTile) return;
    const draft = selectedTile.layerDraft || selectedTile;
    const rawMaskId = rawCanvas ? await storeCanvas(rawCanvas, assets) : draft.rawMaskId;
    if (!rawMaskId) throw new Error('请先生成蒙版。');
    const processed = await processedMatte(selectedTile, assets, rawMaskId, threshold, feather);
    if (current()) changeTile(selectedTile.id, { layerDraft: { ...draft, ...processed, rawMaskId, threshold, feather, groundId: '' } });
  }, false);
  const updateLayerQueue = (change) => apply((p) => p.layerQueue ? ({ ...p, layerQueue: change(p.layerQueue) }) : p, false);
  async function pumpLayerQueue() {
    if (layerPump.current || !ref.current.layerQueue || !guardService()) return;
    layerPump.current = true; setLayerPumpActive(true); const token = ++layerEpoch.current, running = new Set();
    const current = () => mounted.current && token === layerEpoch.current;
    try {
      while (current()) {
        const q = ref.current.layerQueue;
        if (q) { assets.requestTaskId = q.id; assets.requestTaskName = '物件蒙版自动任务'; }
        if (!q || !['running', 'pausing', 'paused'].includes(q.status)) break;
        if (q.status === 'running') {
          for (const task of q.tasks.filter((item) => item.status === 'waiting').slice(0, Math.max(0, q.concurrency - running.size))) {
            updateLayerQueue((value) => ({ ...value, tasks: value.tasks.map((item) => item.id === task.id ? { ...item, status: 'running', error: '' } : item) }));
            const abort = new AbortController(); layerControllers.current.set(task.id, abort);
            const job = (async () => {
              try {
                const snapshot = { ...ref.current, ...q.settings }, target = snapshot.tiles.find((item) => item.id === task.tileId);
                if (!target) throw new Error(`地图块 ${task.x}, ${task.y} 已不存在。`);
                const generated = await generateMatteTile(snapshot, assets, target, { requestTag: `图块 (${task.x},${task.y})`, divisions: q.subdivisions, completedParts: task.completedParts, signal: abort.signal,
                  onPart: (completedParts) => { if (current() && !abort.signal.aborted) updateLayerQueue((value) => ({ ...value, tasks: value.tasks.map((item) => item.id === task.id ? { ...item, completedParts } : item) })); } });
                if (!current() || abort.signal.aborted) return;
                const rawMaskId = await storeCanvas(generated.rawMask, assets), processed = await processedMatte(target, assets, rawMaskId);
                if (!current() || abort.signal.aborted) return;
                const draft = { ...processed, layerMode: 'mask', rawMaskId, threshold: 128, feather: 1, groundId: '' };
                apply((value) => ({ ...value, tiles: value.tiles.map((item) => item.id === target.id ? { ...item, layerDraft: draft } : item),
                  layerQueue: { ...value.layerQueue, tasks: value.layerQueue.tasks.map((item) => item.id === task.id ? { ...item, status: 'done', error: '' } : item) } }), false);
              } catch (e) {
                if (current() && !abort.signal.aborted) { updateLayerQueue((value) => ({ ...value, status: 'paused', tasks: value.tasks.map((item) => item.id === task.id ? { ...item, status: 'failed', error: e.message } : item) })); notify(`物件蒙版队列已暂停：${e.message}`); }
              } finally { if (layerControllers.current.get(task.id) === abort) layerControllers.current.delete(task.id); }
            })();
            running.add(job); job.finally(() => running.delete(job));
          }
        }
        if (!running.size) {
          const queue = ref.current.layerQueue;
          if (queue.tasks.every((task) => task.status === 'done')) { updateLayerQueue((value) => ({ ...value, status: 'complete' })); notify('所有物件蒙版预览已生成，可逐块检查或批量接纳。'); }
          else updateLayerQueue((value) => ({ ...value, status: 'paused' }));
          break;
        }
        await Promise.race(running);
      }
      await Promise.allSettled(running);
      if (current() && ref.current.layerQueue?.status === 'pausing') updateLayerQueue((value) => ({ ...value, status: 'paused' }));
    } finally { if (current()) { layerPump.current = false; setLayerPumpActive(false); } }
  }
  const startLayerBatch = (subdivisions, concurrency) => {
    if (locked || !ref.current.tiles.length || !guardService()) return;
    const p = ref.current, tasks = p.tiles.filter((tile) => !tile.objectsId && !tile.layerDraft?.objectsId)
      .map((tile) => ({ id: uid(), tileId: tile.id, x: tile.x, y: tile.y, status: 'waiting', completedParts: [], error: '' }));
    if (!tasks.length) return notify('所有图块都已有物件层或待检查的预览。');
    const count = [1, 2, 3].includes(Number(subdivisions)) ? Number(subdivisions) : 1;
    const baseline = { ...p, layerQueue: null };
    apply({ ...p, layerQueue: { id: uid(), status: 'running', concurrency: Math.max(1, Math.min(3, Number(concurrency) || 1)), subdivisions: count,
      tasks, baseline, settings: { provider: p.provider, resolution: p.resolution, subdivisions: p.subdivisions, layerPrompts: { ...p.layerPrompts } } } });
    pumpLayerQueue();
  };
  const pauseLayerBatch = () => updateLayerQueue((queue) => ({ ...queue, status: 'pausing' }));
  const resumeLayerBatch = () => {
    if (layerPump.current || !ref.current.layerQueue || !guardService()) return;
    updateLayerQueue((queue) => ({ ...queue, status: 'running', tasks: queue.tasks.map((task) => task.status === 'failed' || task.status === 'running' ? { ...task, status: 'waiting', error: '' } : task) }));
    pumpLayerQueue();
  };
  const stopLayerBatch = () => {
    layerEpoch.current++; for (const abort of layerControllers.current.values()) abort.abort(); layerControllers.current.clear(); layerPump.current = false; setLayerPumpActive(false);
    updateLayerQueue((queue) => ({ ...queue, status: 'stopped', tasks: queue.tasks.map((task) => task.status === 'running' ? { ...task, status: 'waiting' } : task) })); notify('物件蒙版队列已停止，已完成图块和分段已保留。');
  };
  const undoLayerBatch = () => {
    const queue = ref.current.layerQueue;
    if (!layerPumpActive && !busy && queue?.baseline) { apply(queue.baseline); notify('本批物件蒙版预览已撤销。'); }
  };
  const updateDirectLayer = (tile, kind, result) => {
    const draft = tile.layerDraft?.layerMode === 'direct' ? tile.layerDraft : { layerMode: 'direct', objectsId: '', groundId: '', maskId: '', rawMaskId: '' };
    changeTile(tile.id, { layerDraft: { ...draft, [`${kind}Id`]: result.assetId, [`${kind}Valid`]: result.valid, [`${kind}ActualWidth`]: result.width, [`${kind}ActualHeight`]: result.height,
      [`${kind}RawAssetId`]: result.rawAssetId || '', [`${kind}RawMimeType`]: result.rawMimeType || '', [`${kind}Generation`]: result.generation || null,
      ...(kind === 'objects' ? { objectsMatteStats: result.matteStats || null, objectsBeforeCleanupAssetId: result.matteSourceAssetId || '' } : {}) } });
    notify(result.valid ? `${kind === 'objects' ? '透明物件层' : '纯地面层'}已就绪，请与原图叠加检查位置与细节。` : kind === 'objects' ? '结果已保留供检查，但没有有效的真实透明物件区域，暂不能接纳；未自动重试。' : '地面结果已保留供检查，但含透明区域，暂不能接纳；未自动重试。');
  };
  const generateLayer = (kind) => run(`正在独立生成${kind === 'objects' ? '透明物件层' : '纯地面层'}`, async (p, signal, current) => {
    if (!selectedTile) throw new Error('请先选择原图图块。');
    if (kind === 'objects' && !supportsObjectLayers(p.provider)) throw new Error('当前图像服务不支持物件层生成；可切换 Gemini、可灵或 OpenAI，也可导入透明 PNG。');
    const result = await rebuildLayer(p, assets, selectedTile, kind, signal);
    if (current()) updateDirectLayer(ref.current.tiles.find((t) => t.id === selectedTile.id), kind, result);
  });
  const importLayer = (file, kind) => run('正在导入分层 PNG', async (p, signal, current) => {
    if (!selectedTile) throw new Error('请先导入或选择原图图块。');
    const result = await importLayerImage(file, assets, selectedTile, kind);
    if (current()) updateDirectLayer(ref.current.tiles.find((t) => t.id === selectedTile.id), kind, result);
  }, false);
  const cleanObjects = () => run('正在本地清理物件紫底', async (p, signal, current) => {
    const tile = selectedTile, layers = tile?.layerDraft || tile;
    if (!layers?.objectsId) throw new Error('请先生成或导入物件层。');
    const sourceId = layers.objectsBeforeCleanupAssetId || layers.objectsId;
    const objects = canvas(tile.width, tile.height), original = canvas(tile.width, tile.height);
    objects.getContext('2d').drawImage(await assetImage(sourceId, assets), 0, 0, tile.width, tile.height);
    original.getContext('2d').drawImage(await assetImage(tile.originalId, assets), 0, 0, tile.width, tile.height);
    const stats = cleanObjectMatte(objects, original), id = await storeCanvas(objects, assets);
    if (current()) {
      changeTile(tile.id, { layerDraft: { ...layers, layerMode: 'direct', objectsId: id, objectsBeforeCleanupAssetId: sourceId,
        objectsMatteStats: stats, objectsValid: layerAlphaValid(objects, 'objects') && matteValid(stats) } });
      notify(`本地清理完成：移除 ${stats.removedPixels.toLocaleString()} 个紫底像素，修整 ${stats.decontaminatedPixels.toLocaleString()} 个边缘像素。可撤销；未提交生图请求。`);
    }
  }, false);
  const acceptLayers = () => { const draft = selectedTile?.layerDraft; if (locked || !validLayerPair(draft)) return; changeTile(selectedTile.id, { ...draft, layerDraft: null }); notify('地面与物件层已接纳，原图仍保留。'); };
  const acceptAllLayers = () => {
    if (locked) return;
    const ids = new Set(ref.current.tiles.filter((tile) => validLayerPair(tile.layerDraft)).map((tile) => tile.id));
    if (!ids.size) return notify('没有可接纳的物件层预览。');
    apply((p) => ({ ...p, tiles: p.tiles.map((tile) => ids.has(tile.id) ? { ...tile, ...tile.layerDraft, layerDraft: null } : tile) }));
    notify(`已接纳 ${ids.size} 个物件层预览，原图仍保留。`);
  };
  const discardLayers = () => { if (!locked && selectedTile) changeTile(selectedTile.id, { layerDraft: null }); };
  const retouch = (points, prompt) => run('正在局部重绘', async (p, signal, current) => {
    if (!selectedTile || points.length < 3) throw new Error('请先选择图块，并在图块上绘制重绘区域。');
    const tile = await retouchTile(p, assets, selectedTile, points, prompt, signal); if (current()) { setPending({ tile, mode: 'replace', sourceStamp: sourceStamp(p) }); notify('局部重绘预览已就绪。'); }
  });
  const deleteTile = () => { if (!locked && selectedTile && window.confirm('删除选中图块？此操作可以撤销。')) { apply((p) => ({ ...p, tiles: p.tiles.filter((t) => t.id !== selectedTile.id), work: null })); setPending(null); } };
  const addRegion = (type, points) => {
    if (locked || type === 'collision') return null;
    points = regionPolygon(points);
    if (!points) { notify('区域至少需要3个不同顶点且面积不能为零，请继续修改当前轮廓。'); return null; }
    const id = uid(), region = { id, type, name: `${({ collision: '碰撞', occlusion: '遮挡', adjustment: '调节', top: '最上层' })[type]} ${ref.current.regions.length + 1}`, points, baseline: Math.max(...points.map((v) => v.y)), sortOffset: 0, visible: true };
    apply((p) => ({ ...p, regions: [...p.regions, region] })); setSelectedRegionId(id); return region;
  };
  const addRegions = (values) => {
    if (locked || !Array.isArray(values)) return [];
    const valid = values.map((value, index) => {
      const points = regionPolygon(value?.points);
      if (!points) return null;
      const id = uid();
      return { id, type: value.type === 'top' ? 'top' : 'occlusion', name: String(value.name || `遮挡 ${ref.current.regions.length + index + 1}`).slice(0, 100), points,
        baseline: Number.isFinite(value.baseline) ? value.baseline : Math.max(...points.map((point) => point.y)), sortOffset: Number.isFinite(value.sortOffset) ? value.sortOffset : 0, visible: true };
    }).filter(Boolean);
    if (!valid.length) return [];
    apply((p) => ({ ...p, regions: [...p.regions, ...valid] })); setSelectedRegionId(valid.at(-1).id); return valid;
  };
  const setCollisionCells = (values) => {
    if (locked) return;
    const p = ref.current, currentRegion = p.regions.find((region) => region.type === 'collision'), unique = new Map();
    for (const cell of values || []) {
      if (!Number.isInteger(cell?.x) || !Number.isInteger(cell?.y) || cell.x < 0 || cell.y < 0 || cell.x >= p.grid.width || cell.y >= p.grid.height) continue;
      unique.set(`${cell.x},${cell.y}`, { x: cell.x, y: cell.y });
    }
    const cells = [...unique.values()], current = currentRegion?.cells || [];
    if (cells.length === current.length && cells.every((cell) => current.some((value) => value.x === cell.x && value.y === cell.y))) return;
    const id = currentRegion?.id || 'grid-collision';
    apply((project) => ({ ...project, regions: [...project.regions.filter((region) => region.type !== 'collision'), ...(cells.length ? [{ ...(currentRegion || {}), id, type: 'collision', name: currentRegion?.name || '碰撞格子', cells, visible: true, sortOffset: 0 }] : [])] }));
    setSelectedRegionId(cells.length ? id : '');
  };
  const toggleCollisionCell = (cell) => {
    if (locked || !Number.isInteger(cell?.x) || !Number.isInteger(cell?.y)) return;
    const current = ref.current.regions.find((region) => region.type === 'collision')?.cells || [];
    const exists = current.some((value) => value.x === cell.x && value.y === cell.y);
    setCollisionCells(exists ? current.filter((value) => value.x !== cell.x || value.y !== cell.y) : [...current, cell]);
  };
  const updateRegion = (id, patch) => { if (!locked) apply((p) => ({ ...p, regions: p.regions.map((r) => r.id === id ? { ...r, ...patch } : r) })); };
  const deleteRegion = () => { if (!locked && selectedRegion) { apply((p) => ({ ...p, regions: p.regions.filter((r) => r.id !== selectedRegion.id) })); setSelectedRegionId(''); } };
  const undo = () => {
    if (locked || !history.current.past.length) return;
    const previous = history.current.past.pop(); history.current.future.push(ref.current); apply(previous, false); setPending(null); setHistoryVersion((v) => v + 1);
  };
  const redo = () => {
    if (locked || !history.current.future.length) return;
    const next = history.current.future.pop(); history.current.past.push(ref.current); apply(next, false); setPending(null); setHistoryVersion((v) => v + 1);
  };
  const updateQueue = (change) => apply((p) => p.queue ? ({ ...p, queue: change(p.queue) }) : p, false);
  async function pumpQueue() {
    if (pump.current || !guardService()) return;
    pump.current = true; setPumpActive(true); const token = ++epoch.current, running = new Set();
    const current = () => mounted.current && token === epoch.current;
    try {
      while (current()) {
        const p = ref.current, q = p.queue;
        if (q) { assets.requestTaskId = q.id; assets.requestTaskName = '自动扩图'; }
        if (!q || !['running', 'pausing', 'paused'].includes(q.status)) break;
        if (q.status === 'running') {
          for (const task of readyTasks(p, q.tasks).slice(0, Math.max(0, q.concurrency - running.size))) {
            updateQueue((v) => ({ ...v, tasks: v.tasks.map((t) => t.id === task.id ? { ...t, status: 'running', error: '' } : t) }));
            const abort = new AbortController(); batchControllers.current.set(task.id, abort);
            const job = (async () => {
              try {
                const snapshot = { ...ref.current, ...q.settings };
                const tile = await generateTile(snapshot, assets, task, { requestTag: `图块 (${task.x},${task.y})`, parts: task.completedParts, signal: abort.signal,
                  onPart: (completedParts) => { if (current() && !abort.signal.aborted) updateQueue((v) => ({ ...v, tasks: v.tasks.map((t) => t.id === task.id ? { ...t, completedParts } : t) })); } });
                if (current() && !abort.signal.aborted) apply((v) => ({ ...v, tiles: v.tiles.some((t) => keyOf(t.x, t.y) === keyOf(tile.x, tile.y)) ? v.tiles : [...v.tiles, tile], queue: { ...v.queue, tasks: v.queue.tasks.map((t) => t.id === task.id ? { ...t, status: 'done' } : t) } }), false);
              } catch (e) {
                if (current() && !abort.signal.aborted) { updateQueue((v) => ({ ...v, status: 'paused', tasks: v.tasks.map((t) => t.id === task.id ? { ...t, status: 'failed', error: e.message } : t) })); notify(`自动扩图已暂停：${e.message}`); }
              } finally { if (batchControllers.current.get(task.id) === abort) batchControllers.current.delete(task.id); }
            })();
            running.add(job); job.finally(() => running.delete(job));
          }
        }
        if (!running.size) {
          const queue = ref.current.queue;
          if (queue.tasks.every((t) => t.status === 'done')) { updateQueue((v) => ({ ...v, status: 'complete' })); notify('自动扩图已完成，可整批撤销。'); }
          else updateQueue((v) => ({ ...v, status: 'paused' }));
          break;
        }
        await Promise.race(running);
      }
      await Promise.allSettled(running);
      if (current() && ref.current.queue?.status === 'pausing') updateQueue((v) => ({ ...v, status: 'paused' }));
    } finally { if (current()) { pump.current = false; setPumpActive(false); } }
  }
  const startBatch = (width, height, concurrency) => {
    if (locked || !selectedTile || !guardService()) return;
    const p = ref.current, tasks = batchTargets(p, selectedTile, width, height); if (!tasks.length) return notify('范围内没有待生成的空位。');
    const baseline = { ...p, queue: null, work: null };
    apply({ ...p, work: null, queue: { id: uid(), status: 'running', concurrency, tasks, baseline, settings: { provider: p.provider, resolution: p.resolution, subdivisions: p.subdivisions, prompt: p.prompt, negativePrompt: p.negativePrompt, globalPositivePrompt: p.globalPositivePrompt, globalNegativePrompt: p.globalNegativePrompt, grid: { ...p.grid }, pixelsPerUnit: p.pixelsPerUnit, scaleReference: normalizeScaleReference(p.scaleReference) } } }); setPending(null); pumpQueue();
  };
  const pauseBatch = () => updateQueue((q) => ({ ...q, status: 'pausing' }));
  const resumeBatch = () => {
    if (pump.current || !ref.current.queue || !guardService()) return;
    if (!history.current.past.length && ref.current.queue.baseline) pushHistory(ref.current.queue.baseline);
    updateQueue((q) => ({ ...q, status: 'running', tasks: q.tasks.map((t) => t.status === 'failed' || t.status === 'running' ? { ...t, status: 'waiting', error: '' } : t) })); pumpQueue();
  };
  const stopBatch = () => {
    epoch.current++; for (const c of batchControllers.current.values()) c.abort(); batchControllers.current.clear(); pump.current = false; setPumpActive(false);
    updateQueue((q) => ({ ...q, status: 'stopped', tasks: q.tasks.map((t) => t.status === 'running' ? { ...t, status: 'waiting' } : t) })); notify('队列已停止，完成的图块与分段已保留。');
  };
  const undoBatch = () => { if (!pumpActive && !busy && ref.current.queue?.baseline) { apply(ref.current.queue.baseline); setPending(null); notify('本批生成的图块已撤销。'); } };
  return { project, ref, assets, ready, busy, error, clearError: () => setError(''), pending, selectedTile, selectedRegion, selectedId, selectedRegionId, setSelectedId, setSelectedRegionId,
    locked, pumpActive, layerPumpActive, apply, patch, updateScaleReference, loadScalePreset, importCharacter, save, load, listProjects, createNew, importBase, importStyle, importZip, extractStyle, previewPrompts, seed, expand, accept, discard, cancel, changeOverlap,
    matte, ground, generateLayer, importLayer, cleanObjects, editMatte, acceptLayers, acceptAllLayers, discardLayers, startLayerBatch, pauseLayerBatch, resumeLayerBatch, stopLayerBatch, undoLayerBatch, retouch, deleteTile, addRegion, addRegions, toggleCollisionCell, setCollisionCells, updateRegion, deleteRegion, undo, redo,
    canUndo: historyVersion >= 0 && history.current.past.length > 0, canRedo: history.current.future.length > 0,
    startBatch, pauseBatch, resumeBatch, stopBatch, undoBatch };
}
