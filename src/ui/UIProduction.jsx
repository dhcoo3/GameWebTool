import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import importerCode from '../../unity/UI/Editor/FactoryUiImporter.cs?raw';
import { buildUiExport, downloadUiFile } from './export.js';
import { hasUsableUiContour, recommendedUiExtractionMode, shouldUseUiContour } from './segmentation.js';
import { createUiId, deleteUiProject, getUiAsset, listUiProjects, putUiAsset, saveUiProject } from './storage.js';
import './ui-production.css';
import { layerTree, validateHierarchy } from './layers.js';
import { clampBounds } from './manifest.js';
import { decodePixels, rgbaPng } from './raster.js';
import { useLayerWorkbench } from './useLayerWorkbench.js';

const IMAGE_PROVIDERS = [
  ['gemini', 'Google Nano Banana'], ['openai', 'OpenAI GPT Image'], ['apiyi', 'API易 GPT Image'], ['qwen', '阿里云百炼 · 千问'], ['kling', '可灵 AI'],
];
const ANALYSIS_PROVIDERS = IMAGE_PROVIDERS.filter(([id]) => ['gemini', 'openai', 'apiyi', 'qwen'].includes(id));
const shortId = () => createUiId().slice(0, 8);

function blankProject(provider = 'gemini') {
  return {
    id: createUiId(), name: '未命名 UI', sourceAssetId: '', sourceName: '', sourceMimeType: '', width: 0, height: 0,
    prompt: '', negativePrompt: '', widthRequest: 1920, heightRequest: 1080, imageProvider: provider,
    analysisProvider: ['openai', 'apiyi', 'gemini', 'qwen'].includes(provider) ? provider : 'gemini',
    assets: [], uncertain: [], analysisModel: '', approved: false, createdAt: Date.now(), pipelineVersion: 2, restorations: {}, blobIds: [],
  };
}

function base64FromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('读取图片失败。'));
    reader.readAsDataURL(blob);
  });
}

function responseError(payload, fallback) { return payload?.error || payload?.message || fallback; }

function Icon({ name, size = 16 }) {
  const paths = {
    upload: <><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M20 16v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3"/></>,
    spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></>,
    zip: <><path d="M4 3h12l4 4v14H4z"/><path d="M9 3v3h4V3m-2 3v2m0 2v2m0 2v2m0 2v2"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    trash: <><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function UIProduction({ config, serverOffline, onOpenSettings, onNotify }) {
  const [project, setProject] = useState(null);
  const [projects, setProjects] = useState([]);
  const [ready, setReady] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [maskTool, setMaskTool] = useState('');
  const [brushRadius, setBrushRadius] = useState(12);
  const [showOriginal, setShowOriginal] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [preparedExport, setPreparedExport] = useState(null);
  useEffect(() => () => { if (preparedExport) URL.revokeObjectURL(preparedExport.url); }, [preparedExport]);
  useEffect(() => { setPreparedExport(null); }, [project?.id, project?.assets, project?.restorations, project?.sourceAssetId]);
  const stageRef = useRef(null);
  const svgRef = useRef(null);
  const fileRef = useRef(null);
  const pointerRef = useRef(null);

  const configured = config?.configured || {};
  const selectedAsset = project?.assets?.find((asset) => asset.id === selectedId) || null;
  const orderedAssets = useMemo(() => [...(project?.assets || [])].sort((a, b) => a.order - b.order), [project?.assets]);
  const treeAssets = useMemo(() => { try { return layerTree(project?.assets || []); } catch { return orderedAssets; } }, [project?.assets, orderedAssets]);
  const contourSuggestionCount = project?.assets?.filter(shouldUseUiContour).length || 0;
  const cropPreviewScale = selectedAsset ? Math.min(260 / selectedAsset.bounds.width, 126 / selectedAsset.bounds.height) : 0;
  const cropPreviewWidth = selectedAsset ? Math.max(1, Math.round(selectedAsset.bounds.width * cropPreviewScale)) : 0;
  const scale = project?.width && project?.height && viewport.width && viewport.height
    ? Math.min(1, viewport.width / project.width, viewport.height / project.height) * zoom : 0;
  const displayWidth = Math.round((project?.width || 0) * scale), displayHeight = Math.round((project?.height || 0) * scale);

  useEffect(() => {
    let active = true;
    listUiProjects().then((items) => {
      if (!active) return;
      const currentId = window.localStorage.getItem('ui-production-active-project');
      const current = items.find((item) => item.id === currentId) || [...items].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0] || blankProject();
      setProjects(items); setProject(current); setSelectedId(current.assets?.[0]?.id || ''); setReady(true);
      window.localStorage.setItem('ui-production-active-project', current.id);
    }).catch((reason) => { setError(`无法打开本地 UI 项目：${reason.message}`); setProject(blankProject()); setReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!project?.sourceAssetId) { setSourceUrl(''); return; }
    let active = true, objectUrl = '';
    getUiAsset(project.sourceAssetId).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob); setSourceUrl(objectUrl);
    }).catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [project?.sourceAssetId]);

  useEffect(() => {
    if (!ready || !project) return undefined;
    setSaved(false);
    const timer = window.setTimeout(() => {
      saveUiProject(project).then(async () => {
        window.localStorage.setItem('ui-production-active-project', project.id);
        setSaved(true); setProjects(await listUiProjects());
      }).catch((reason) => setError(`项目自动保存失败：${reason.message}`));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [project, ready]);

  useEffect(() => {
    if (!stageRef.current) return undefined;
    const element = stageRef.current;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width - 24, height: entry.contentRect.height - 24 }));
    observer.observe(element); return () => observer.disconnect();
  }, [sourceUrl]);

  const notify = useCallback((message) => { onNotify?.(message); }, [onNotify]);
  const layers = useLayerWorkbench({ project, setProject, selectedId, setBusy, setError, notify });
  const updateProject = useCallback((patch, invalidate = true) => {
    setProject((current) => {
      if (!current) return current;
      const changes = typeof patch === 'function' ? patch(current) : patch, next = { ...current, ...changes };
      if (invalidate) next.approved = false;
      if (invalidate && changes.assets) {
        next.assets = next.assets.map((a) => ({ ...a, reviewed: false }));
        next.restorations = Object.fromEntries(Object.entries(next.restorations || {}).map(([id, r]) => [id, { ...r, accepted: false }]));
      }
      return next;
    });
  }, []);
  const updateAsset = useCallback((id, transform) => {
    updateProject((current) => {
      const assets = current.assets.map((asset) => {
        if (asset.id !== id) return asset;
        const patch = typeof transform === 'function' ? transform(asset) : transform;
        if (patch.bounds) { patch.bounds = clampBounds(patch.bounds, current.width, current.height); patch.maskStale = Boolean(asset.maskAssetId); }
        return { ...asset, ...patch };
      });
      try { validateHierarchy(assets); } catch (reason) { setError(reason.message); return {}; }
      return { assets };
    });
  }, [updateProject]);

  const useSource = useCallback(async (blob, fileName) => {
    const type = blob.type || 'image/png';
    if (!/^image\/(png|jpeg|webp)$/.test(type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
    if (blob.size > 24 * 1024 * 1024) throw new Error('图片超过 24 MB，请先缩小文件后重试。');
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width > 8192 || bitmap.height > 8192) { bitmap.close(); throw new Error('图片单边不能超过 8192 像素。'); }
    const sourceWidth = bitmap.width, sourceHeight = bitmap.height; bitmap.close();
    const decoded = await decodePixels(blob), canonical = rgbaPng(decoded.data, decoded.width, decoded.height);
    const [sourceAssetId, originalAssetId] = await Promise.all([putUiAsset(canonical), putUiAsset(blob)]);
    setProject((current) => current ? { ...current, pipelineVersion: 2, sourceAssetId, originalAssetId, blobIds: [...(current.blobIds || []), current.sourceAssetId, sourceAssetId, originalAssetId].filter(Boolean), sourceName: fileName || 'generated-ui.png', sourceMimeType: 'image/png', width: sourceWidth, height: sourceHeight, assets: [], restorations: {}, uncertain: [], analysisModel: '', approved: false, sourceHash: '' } : current);
    setSelectedId(''); setError(''); setMaskTool('');
  }, []);

  const importImage = useCallback(async (file) => {
    if (!file) return;
    setBusy('正在导入图片'); setError('');
    try { await useSource(file, file.name); notify('UI 图片已导入。'); }
    catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  }, [notify, useSource]);

  const generateImage = useCallback(async () => {
    if (!project?.prompt.trim()) { setError('请先填写 UI 生成描述。'); return; }
    const requestedWidth = Number(project.widthRequest), requestedHeight = Number(project.heightRequest);
    if (!Number.isInteger(requestedWidth) || !Number.isInteger(requestedHeight) || requestedWidth < 256 || requestedHeight < 256 || requestedWidth > 8192 || requestedHeight > 8192) { setError('生成尺寸需为 256 至 8192 之间的整数。'); return; }
    if (!configured[project.imageProvider]) { setError('所选图像服务尚未配置，请先打开服务设置。'); return; }
    setBusy('正在生成 UI'); setError('');
    try {
      const response = await fetch('/api/scene/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        provider: project.imageProvider, prompt: project.prompt, negativePrompt: project.negativePrompt,
        width: requestedWidth, height: requestedHeight, mimeType: 'image/png', imageBase64: '',
      }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(responseError(payload, 'UI 生成失败。'));
      const binary = atob(payload.imageBase64), data = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
      const mimeType = payload.mimeType || 'image/png', extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
      await useSource(new Blob([data], { type: mimeType }), `ui-${Date.now()}.${extension}`);
      setProject((current) => current ? { ...current, lastGenerationModel: payload.model || '' } : current);
      notify(`UI 已生成${payload.model ? ` · ${payload.model}` : ''}，接下来可以识别元素。`);
    } catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  }, [configured, notify, project, useSource]);

  const analyzeImage = useCallback(async () => {
    if (!project?.sourceAssetId) { setError('请先生成或导入 UI 图片。'); return; }
    if (!configured[project.analysisProvider]) { setError('所选标注服务尚未配置，请先打开服务设置。'); return; }
    setBusy('AI 正在识别 UI 元素'); setError('');
    try {
      const blob = await getUiAsset(project.sourceAssetId), imageBase64 = await base64FromBlob(blob);
      const response = await fetch('/api/ui/assets/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        provider: project.analysisProvider, imageBase64, imageMimeType: blob.type || project.sourceMimeType || 'image/png',
        width: project.width, height: project.height, goal: project.prompt || project.name,
      }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(responseError(payload, 'UI 元素识别失败。'));
      const assets = (payload.analysis?.assets || []).map((asset, index) => ({
        id: asset.id || createUiId(), parentId: asset.parentId || '', zIndex: asset.zIndex ?? index, occludedBy: asset.occludedBy || [], reviewed: false,
        name: asset.name || `UI 元素 ${index + 1}`, category: asset.category || '其他',
        bounds: { x: asset.x, y: asset.y, width: asset.width, height: asset.height },
        polygon: asset.polygon || [], confidence: asset.confidence ?? 0, notes: asset.notes || '',
        order: asset.zIndex ?? index, enabled: true, extractionMode: 'mask', maskStrokes: [], maskRedo: [],
      }));
      updateProject((current) => ({ assets, grids: payload.analysis?.grids || [], pipelineVersion: 2, restorations: {}, uncertain: payload.analysis?.uncertain || [], analysisModel: payload.model || current.analysisProvider }));
      setSelectedId(assets[0]?.id || ''); setMaskTool(''); setShowOriginal(false);
      layers.setView('boxes'); notify(`识别到 ${assets.length} 个候选组件；检查范围后运行本机轮廓分割。`);
    } catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  }, [configured, notify, project, updateProject]);

  const selectProject = useCallback((id) => {
    if (id === '__new__') { const next = blankProject(); setProject(next); setSelectedId(''); setMaskTool(''); window.localStorage.setItem('ui-production-active-project', next.id); return; }
    const next = projects.find((item) => item.id === id);
    if (next) { setProject(next); setSelectedId(next.assets?.[0]?.id || ''); setMaskTool(''); window.localStorage.setItem('ui-production-active-project', next.id); }
  }, [projects]);

  const addAsset = useCallback(() => {
    if (!project?.width) return;
    const width = Math.max(24, Math.round(Math.min(240, project.width / 4))), height = Math.max(24, Math.round(Math.min(120, project.height / 5)));
    const asset = { id: createUiId(), name: `新元素 ${project.assets.length + 1}`, category: '其他', bounds: { x: Math.round((project.width - width) / 2), y: Math.round((project.height - height) / 2), width, height }, polygon: [], confidence: 1, notes: '人工新增', order: project.assets.length, enabled: true, extractionMode: 'rect', maskStrokes: [] };
    updateProject((current) => ({ assets: [...current.assets, asset] })); setSelectedId(asset.id); setMaskTool('');
  }, [project, updateProject]);

  const removeAsset = useCallback((id) => {
    updateProject((current) => ({ assets: current.assets.filter((asset) => asset.id !== id).map((asset, index) => ({ ...asset, parentId: asset.parentId === id ? '' : asset.parentId, occludedBy: (asset.occludedBy || []).filter((other) => other !== id), order: index, zIndex: index })) }));
    if (selectedId === id) setSelectedId(project.assets.find((asset) => asset.id !== id)?.id || '');
  }, [project, selectedId, updateProject]);

  const reorderAsset = useCallback((id, direction) => {
    const assets = [...orderedAssets], index = assets.findIndex((asset) => asset.id === id), target = index + direction;
    if (index < 0 || target < 0 || target >= assets.length) return;
    [assets[index], assets[target]] = [assets[target], assets[index]];
    updateProject({ assets: assets.map((asset, order) => ({ ...asset, order, zIndex: order })) });
  }, [orderedAssets, updateProject]);

  const applyContourSuggestions = useCallback(() => {
    if (!contourSuggestionCount) { setError('没有可用于不规则裁切的 AI 轮廓。请重新识别，或为元素手动添加轮廓。'); return; }
    updateProject((current) => ({ assets: current.assets.map((asset) => shouldUseUiContour(asset) ? { ...asset, extractionMode: 'mask' } : asset) }));
    setShowOriginal(false); setMaskTool(''); setError('');
    notify(`已为 ${contourSuggestionCount} 个图标、徽标或装饰应用 AI 轮廓裁切，请逐个检查边缘。`);
  }, [contourSuggestionCount, notify, updateProject]);

  const confirmSplit = useCallback(() => {
    if (!project?.assets?.length) { setError('请先运行 AI 标注或手工添加 UI 元素。'); return; }
    if (project.pipelineVersion === 2 && project.assets.some((a) => a.enabled !== false && (!a.reviewed || a.maskStale))) { setError('请先逐层检查并点击“确认本层边缘”。'); return; }
    setProject((current) => ({ ...current, approved: true })); setMaskTool(''); setError(''); notify('拆分方案已确认，可以导出。');
  }, [notify, project]);

  const exportPackage = useCallback(async (unity) => {
    if (!project?.sourceAssetId || !project.approved) return;
    setBusy(unity ? '正在制作 Unity 资源包' : '正在制作素材资源包'); setError('');
    try {
      const sourceBlob = await getUiAsset(project.sourceAssetId);
      const blob = await buildUiExport(project, sourceBlob, { unity, importerCode });
      const name = (project.name || 'ui').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const fileName = `${name}-${unity ? 'Unity' : '素材'}.zip`;
      setPreparedExport({ url: URL.createObjectURL(blob), name: fileName });
      downloadUiFile(blob, fileName);
      notify(unity ? 'Unity UGUI 资源包已导出。' : 'UI 独立素材包已导出。');
    } catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  }, [notify, project]);

  const pointerPoint = useCallback((event) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || !project?.width || !project?.height) return { x: 0, y: 0 };
    return { x: Math.max(0, Math.min(project.width, (event.clientX - bounds.left) * project.width / bounds.width)), y: Math.max(0, Math.min(project.height, (event.clientY - bounds.top) * project.height / bounds.height)) };
  }, [project?.width, project?.height]);

  const beginBrush = useCallback((event) => {
    if (!maskTool || !selectedAsset || selectedAsset.extractionMode !== 'mask') return;
    event.preventDefault(); event.stopPropagation();
    const point = pointerPoint(event), strokeId = createUiId();
    svgRef.current?.setPointerCapture(event.pointerId);
    pointerRef.current = { type: 'brush', id: selectedAsset.id, strokeId, points: [point] };
    updateAsset(selectedAsset.id, (asset) => ({ maskRedo: [], maskStrokes: [...(asset.maskStrokes || []), { id: strokeId, mode: maskTool, radius: brushRadius, points: [point] }] }));
  }, [brushRadius, maskTool, pointerPoint, selectedAsset, updateAsset]);

  const beginBoxAction = useCallback((event, id, type) => {
    if (maskTool) return;
    event.preventDefault(); event.stopPropagation();
    const point = pointerPoint(event), asset = project.assets.find((item) => item.id === id);
    if (!asset) return;
    setSelectedId(id); svgRef.current?.setPointerCapture(event.pointerId);
    pointerRef.current = { type, id, start: point, bounds: { ...asset.bounds } };
  }, [maskTool, pointerPoint, project?.assets]);

  const onPointerMove = useCallback((event) => {
    const action = pointerRef.current;
    if (!action || !project) return;
    const point = pointerPoint(event), dx = point.x - action.start?.x, dy = point.y - action.start?.y;
    if (action.type === 'brush') {
      action.points.push(point);
      updateAsset(action.id, (asset) => ({ maskStrokes: (asset.maskStrokes || []).map((stroke) => stroke.id === action.strokeId ? { ...stroke, points: [...action.points] } : stroke) }));
    } else if (action.type === 'move') {
      const bounds = action.bounds;
      updateAsset(action.id, { bounds: { ...bounds, x: Math.max(0, Math.min(project.width - bounds.width, Math.round(bounds.x + dx))), y: Math.max(0, Math.min(project.height - bounds.height, Math.round(bounds.y + dy))) } });
    } else if (action.type === 'resize') {
      const bounds = action.bounds;
      updateAsset(action.id, { bounds: { ...bounds, width: Math.max(2, Math.min(project.width - bounds.x, Math.round(bounds.width + dx))), height: Math.max(2, Math.min(project.height - bounds.y, Math.round(bounds.height + dy))) } });
    }
  }, [pointerPoint, project, updateAsset]);

  const endPointer = useCallback(() => { pointerRef.current = null; }, []);

  if (!project) return <main className="ui-loading">正在打开 UI 项目…</main>;

  return <main className="ui-production-page">
    <div className="ui-workspace-heading" inert={Boolean(busy)}>
      <div className="ui-project-title"><span className="panel-eyebrow">UI ASSET WORKBENCH</span><input aria-label="UI 项目名称" value={project.name} onChange={(event) => updateProject({ name: event.target.value })}/><span className={`ui-save-state ${saved ? 'is-saved' : ''}`}>{saved ? '本地已保存' : '保存中…'}</span></div>
      <div className="ui-workspace-actions">
        <select aria-label="打开本地 UI 项目" value={projects.some((item) => item.id === project.id) ? project.id : '__new__'} onChange={(event) => selectProject(event.target.value)}>
          <option value="__new__">新建项目</option>{projects.some((item) => item.id === project.id) && <option value={project.id}>{project.name || '未命名 UI'}（当前）</option>}{projects.filter((item) => item.id !== project.id).map((item) => <option value={item.id} key={item.id}>{item.name || '未命名 UI'}</option>)}
        </select>
        <button className="ui-quiet-button" onClick={() => selectProject('__new__')}>新建</button>
        <button className="ui-quiet-button" disabled={!projects.some((item) => item.id === project.id)} onClick={async () => { if (!window.confirm(`删除“${project.name}”项目？`)) return; await deleteUiProject(project.id); setProjects(await listUiProjects()); selectProject('__new__'); }}>删除</button>
      </div>
    </div>

    <div className="ui-stepbar">
      <span className={project.sourceAssetId ? 'complete' : 'current'}><b>01</b> 生成或导入</span><i/>
      <span className={project.assets.length ? 'complete' : project.sourceAssetId ? 'current' : ''}><b>02</b> AI 标注与校对</span><i/>
      <span className={project.approved ? 'complete' : ''}><b>03</b> 导出到 Unity</span>
      <span className="ui-step-hint">标注仅是建议；校对确认后才可导出</span>
    </div>

    <div className="ui-workspace" inert={Boolean(busy)}>
      <aside className="ui-control-panel">
        <div className="ui-panel-heading"><span className="panel-eyebrow">01 / INPUT</span><strong>生成 UI 或导入整图</strong></div>
        <div className="ui-mode-tabs"><button className={!project.sourceMode || project.sourceMode === 'generate' ? 'active' : ''} onClick={() => updateProject({ sourceMode: 'generate' })}>AI 生成</button><button className={project.sourceMode === 'import' ? 'active' : ''} onClick={() => updateProject({ sourceMode: 'import' })}>导入已有图</button></div>
        {project.sourceMode === 'import' ? <div className="ui-import-box">
          <button className="ui-outline-button" onClick={() => fileRef.current?.click()}><Icon name="upload"/>选择 UI 图片</button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; importImage(file); }}/>
          <small>PNG / JPEG / WebP · 单边不超过 8192 px · 最大 24 MB</small>
          {project.sourceName && <span className="ui-source-filename">当前：{project.sourceName}</span>}
        </div> : <>
          <label className="ui-field-label" htmlFor="ui-provider">图像生成服务</label>
          <select id="ui-provider" className="ui-select" value={project.imageProvider} onChange={(event) => updateProject({ imageProvider: event.target.value })}>{IMAGE_PROVIDERS.map(([id, name]) => <option value={id} key={id}>{name}{configured[id] ? ' · 已配置' : ' · 未配置'}</option>)}</select>
          <label className="ui-field-label" htmlFor="ui-prompt">UI 画面描述</label>
          <textarea id="ui-prompt" className="ui-textarea" value={project.prompt} onChange={(event) => updateProject({ prompt: event.target.value })} placeholder="例如：暗黑奇幻风格的背包界面，包含物品格、详情面板、页签和底部状态栏。完整单屏游戏 UI，清晰分区，无设备外框。"/>
          <label className="ui-field-label" htmlFor="ui-negative">避免内容（可选）</label>
          <textarea id="ui-negative" className="ui-textarea compact" value={project.negativePrompt} onChange={(event) => updateProject({ negativePrompt: event.target.value })} placeholder="例如：模糊文字、水印、重复按钮"/>
          <div className="ui-size-fields"><label><span>宽度</span><input type="number" min="256" max="8192" value={project.widthRequest} onChange={(event) => updateProject({ widthRequest: event.target.value })}/></label><span>×</span><label><span>高度</span><input type="number" min="256" max="8192" value={project.heightRequest} onChange={(event) => updateProject({ heightRequest: event.target.value })}/></label></div>
          <button className="ui-primary-button" disabled={Boolean(busy) || serverOffline} onClick={generateImage}><Icon name="spark"/>{busy === '正在生成 UI' ? '生成中…' : '生成 UI'}<span>可能产生 API 费用</span></button>
          <button className="ui-text-button" onClick={() => onOpenSettings?.()}>⚙ 服务设置</button>
        </>}

        <div className="ui-panel-divider"/>
        <div className="ui-panel-heading"><span className="panel-eyebrow">02 / ANALYZE</span><strong>识别 UI 元素</strong></div>
        <label className="ui-field-label" htmlFor="ui-analysis-provider">图片分析服务</label>
        <select id="ui-analysis-provider" className="ui-select" value={project.analysisProvider} onChange={(event) => updateProject({ analysisProvider: event.target.value })}>{ANALYSIS_PROVIDERS.map(([id, name]) => <option value={id} key={id}>{name}{configured[id] ? ' · 已配置' : ' · 未配置'}</option>)}</select>
        <p className="ui-helper-copy">AI 框和轮廓都是估算，置信度不代表像素边界精度。选中元素后先检查右侧“当前裁切预览”，确认不带入邻近内容且没有截断，再确认拆分。</p>
        <button className="ui-outline-button full" disabled={!project.sourceAssetId || Boolean(busy) || serverOffline} onClick={analyzeImage}><Icon name="spark"/>{busy === 'AI 正在识别 UI 元素' ? '识别中…' : 'AI 识别元素'}</button>
        <div className="ui-local-runtime"><strong>本机像素分割 · SAM 2.1 Tiny</strong><small>{layers.status?.modelReady ? `${layers.status.device?.toUpperCase()} · 已安装` : layers.status?.error || '检查本机模型…'}</small>{layers.status?.fallbackReason && <small>{layers.status.fallbackReason}</small>}<button className="ui-text-button" onClick={layers.refreshStatus}>刷新模型状态</button></div>
        <button className="ui-outline-button full" disabled={!project.assets.length || !layers.status?.modelReady || Boolean(busy)} onClick={() => { setShowOriginal(false); layers.segment(project.assets.filter((a) => a.enabled !== false).map((a) => a.id)); }}>分割全部候选轮廓</button>
        <p className="ui-helper-copy">AI 提议组件和层级，本机模型计算像素蒙版。评分不等于边缘准确率，每层仍需验边。</p>
        {project.analysisModel && <small className="ui-model-note">上次标注：{project.analysisModel}</small>}
        {project.uncertain?.length > 0 && <div className="ui-uncertain-box"><strong>请留意这些位置</strong>{project.uncertain.map((item, index) => <span key={index}>• {item}</span>)}</div>}
        <div className="ui-local-notice">图片与项目保存在当前浏览器。调用已配置的 AI 服务时，提示词和所选图片会发送给对应服务商。</div>
        {project.pipelineVersion === 2 && layers.rendered && <div className="ui-restoration-panel">
          <div className="ui-panel-divider"/><strong>补齐被遮挡区域</strong>
          <select className="ui-select" aria-label="补齐目标图层" value={layers.restoreTarget} onChange={(e) => layers.setRestoreTarget(e.target.value)}><option value="__background__">场景背景</option>{orderedAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <button className="ui-outline-button full" onClick={() => { setShowOriginal(false); layers.setView('restore-mask'); }}>预览补齐范围</button>
          <label className="ui-check-label"><input type="checkbox" checked={layers.maskConfirmed} onChange={(e) => layers.setMaskConfirmed(e.target.checked)}/>已检查粉色范围，允许 AI 重建</label>
          <button className="ui-outline-button full" disabled={!layers.maskConfirmed || !configured.gemini || !layers.targetLayer?.hiddenMask.some(Boolean)} onClick={() => { setShowOriginal(false); layers.restore(); }}>Gemini 补齐 · 会产生费用</button>
          {layers.restoration && <>
            <div className="ui-mode-tabs"><button onClick={() => { setShowOriginal(false); layers.setView('restore-raw'); }}>模型完整结果</button><button onClick={() => { setShowOriginal(false); layers.setView('restore-composite'); }}>局部合成结果</button></div>
            <button className="ui-confirm-button" onClick={() => { setProject((current) => ({ ...current, approved: false, assets: current.assets.map((a) => a.id === layers.restoreTarget ? { ...a, reviewed: false } : a), restorations: { ...current.restorations, [layers.restoreTarget]: { ...current.restorations[layers.restoreTarget], accepted: !layers.restoration.accepted } } })); layers.setView('reassembled'); }}>{layers.restoration.accepted ? '撤回此补齐版本' : '确认使用局部合成结果'}</button>
          </>}
          <p className="ui-helper-copy">只替换确认范围内的像素；未补齐的区域保持透明。AI 重建不代表真实隐藏内容。</p>
        </div>}
      </aside>

      <section className="ui-preview-panel">
        <div className="ui-preview-toolbar"><div><span className="panel-eyebrow">SOURCE IMAGE</span><strong>{project.sourceAssetId ? `${project.width} × ${project.height} px` : '等待 UI 图片'}</strong></div><div className="ui-preview-tools">
          {project.sourceAssetId && <><button className={showOriginal ? 'selected' : ''} onClick={() => setShowOriginal(true)}>原图</button><button className={!showOriginal && layers.view === 'boxes' ? 'selected' : ''} onClick={() => { setShowOriginal(false); layers.setView('boxes'); }}>范围 / 蒙版</button><button onClick={addAsset} title="手工添加区域"><Icon name="plus"/> 添加区域</button></>}
        </div></div>
        {project.pipelineVersion === 2 && sourceUrl && <div className="ui-layer-toolbar">
          <button disabled={!selectedAsset} className={!showOriginal && layers.view === 'layer' ? 'selected' : ''} onClick={() => { setShowOriginal(false); layers.setView('layer'); }}>单层验边</button>
          <button className={!showOriginal && layers.view === 'reassembled' ? 'selected' : ''} onClick={() => { setShowOriginal(false); layers.setView('reassembled'); }}>独立重组</button>
          <button disabled={!selectedAsset} onClick={() => { layers.setHiddenIds((ids) => ids.includes(selectedId) ? ids.filter((id) => id !== selectedId) : [...ids, selectedId]); setShowOriginal(false); layers.setView('reassembled'); }}>{layers.hiddenIds.includes(selectedId) ? '显示选中层' : '隐藏选中层'}</button>
          <select aria-label="预览背景" value={layers.background} onChange={(e) => layers.setBackground(e.target.value)}><option value="checker">棋盘格</option><option value="white">白底</option><option value="black">黑底</option></select>
          <select aria-label="预览缩放" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}><option value="1">适应画布</option><option value="2">放大 2 倍</option><option value="4">放大 4 倍</option></select>
        </div>}
        <div className={`ui-image-stage ui-background-${layers.background}`} ref={stageRef}>
          {sourceUrl && displayWidth > 0 ? <div className="ui-preview-image" style={{ width: displayWidth, height: displayHeight }}>
            <img src={!showOriginal && layers.previewUrl ? layers.previewUrl : sourceUrl} alt={showOriginal ? '当前 UI 源图' : '图层校对预览'} draggable="false"/>
            {!showOriginal && ['boxes', 'layer'].includes(layers.view) && <svg ref={svgRef} viewBox={`0 0 ${project.width} ${project.height}`} preserveAspectRatio="none" onPointerDown={beginBrush} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onContextMenu={(event) => event.preventDefault()}>
              {layers.view === 'boxes' && layers.overlayUrl && <image href={layers.overlayUrl} width={project.width} height={project.height} pointerEvents="none"/>}
              {orderedAssets.filter((asset) => asset.enabled !== false && (layers.view === 'boxes' || asset.id === selectedId)).map((asset, index) => {
                const { x, y, width, height } = asset.bounds, active = asset.id === selectedId;
                const polygonPoints = (asset.polygon || []).map((point) => `${point.x},${point.y}`).join(' ');
                return <g key={asset.id}>
                  {layers.view === 'boxes' && <rect x={x} y={y} width={width} height={height} className={`ui-asset-box ${active ? 'active' : ''}`} onPointerDown={(event) => beginBoxAction(event, asset.id, 'move')} onClick={() => { if (!maskTool) setSelectedId(asset.id); }}/>}
                  <text x={x + 5} y={Math.max(18, y + 20)} className="ui-asset-label" onPointerDown={(event) => beginBoxAction(event, asset.id, 'move')}>{index + 1} {asset.name}</text>
                  {hasUsableUiContour(asset) && <polygon points={polygonPoints} className={`ui-mask-polygon ${active ? 'active' : ''}`} />}
                  {active && asset.extractionMode === 'mask' && (asset.maskStrokes || []).map((stroke) => <polyline key={stroke.id} points={stroke.points.map((point) => `${point.x},${point.y}`).join(' ')} className={`ui-mask-stroke ${stroke.mode}`} strokeWidth={stroke.radius * 2} />)}
                  {active && !maskTool && layers.view === 'boxes' && <><rect x={x + width - 10} y={y + height - 10} width="20" height="20" className="ui-resize-handle" onPointerDown={(event) => beginBoxAction(event, asset.id, 'resize')}/><text x={x + width - 24} y={y + height - 12} className="ui-size-label">{width}×{height}</text></>}
                </g>;
              })}
            </svg>}
          </div> : <div className="ui-empty-preview"><div className="ui-empty-icon"><Icon name="upload" size={24}/></div><strong>先生成 UI，或导入一张整图</strong><span>AI 会提出可编辑的拆分框，确认后再导出子图</span><button onClick={() => updateProject({ sourceMode: 'import' })}>导入图片</button></div>}
        </div>
          {sourceUrl && <div className="ui-preview-footer"><span>{showOriginal ? '原始图片保持不变' : layers.view === 'reassembled' ? '仅由导出图层组成；完整原图未垫在底层' : '框用于定位；橙色覆盖表示选中蒙版'}</span><span>{selectedAsset ? `选中：${selectedAsset.name}` : '未选中元素'}</span></div>}
      </section>

      <aside className="ui-assets-panel">
        <div className="ui-panel-heading ui-assets-heading"><div><span className="panel-eyebrow">03 / ASSETS</span><strong>元素与导出</strong></div><span className="ui-count-pill">{project.assets.length}</span></div>
        <div className="ui-assets-list">
          {treeAssets.length ? treeAssets.map((asset, index) => <button key={asset.id} style={{ paddingLeft: `${7 + (asset.depth || 0) * 14}px` }} className={`ui-asset-row ${asset.id === selectedId ? 'active' : ''} ${asset.enabled === false ? 'disabled' : ''}`} onClick={() => { setSelectedId(asset.id); setMaskTool(''); setShowOriginal(false); layers.setView('boxes'); }}>
            <span className="ui-asset-number">{String(index + 1).padStart(2, '0')}</span><span className="ui-asset-row-copy"><strong>{asset.name}</strong><small>{asset.category} · 顺序 {asset.zIndex ?? asset.order} · {asset.bounds.width} × {asset.bounds.height}</small></span><span className="ui-confidence">{asset.reviewed ? '已确认' : asset.maskStale ? '需重分割' : '待检查'}</span>
          </button>) : <div className="ui-assets-empty">AI 识别或手工添加后，元素会显示在这里。</div>}
        </div>
        {contourSuggestionCount > 0 && <button className="ui-contour-suggestion" onClick={applyContourSuggestions}>将 {contourSuggestionCount} 个不规则元素应用 AI 轮廓</button>}
        {selectedAsset && <div className="ui-asset-properties">
          <div className="ui-property-heading"><strong>选中元素</strong><div><button onClick={() => reorderAsset(selectedAsset.id, -1)} title="上移层级">↑</button><button onClick={() => reorderAsset(selectedAsset.id, 1)} title="下移层级">↓</button><button onClick={() => removeAsset(selectedAsset.id)} title="删除"><Icon name="trash" size={14}/></button></div></div>
          {layers.cropUrl && project.pipelineVersion === 2 ? <div className="ui-crop-proof"><div className="ui-crop-proof-heading"><strong>真实透明素材预览</strong><span>{layers.selectedLayer?.bounds?.width} × {layers.selectedLayer?.bounds?.height}</span></div><img className="ui-raster-crop" src={layers.cropUrl} alt="按原像素提取的选中图层"/><small>父层已扣除前方图层的可见像素；可切换单层验边检查。</small></div> : sourceUrl && <div className="ui-crop-proof">
            <div className="ui-crop-proof-heading"><strong>当前矩形裁切预览</strong><span>{selectedAsset.bounds.width} × {selectedAsset.bounds.height} px</span></div>
            <div className="ui-crop-proof-stage" style={{ width: `${cropPreviewWidth}px`, aspectRatio: `${selectedAsset.bounds.width} / ${selectedAsset.bounds.height}` }}>
              <img src={sourceUrl} alt="当前裁切范围中的原图内容" draggable="false" style={{ width: `${project.width / selectedAsset.bounds.width * 100}%`, height: `${project.height / selectedAsset.bounds.height * 100}%`, left: `${-selectedAsset.bounds.x / selectedAsset.bounds.width * 100}%`, top: `${-selectedAsset.bounds.y / selectedAsset.bounds.height * 100}%` }}/>
            </div>
            <small>导出会原样裁这块区域；检查是否带入邻近元素或截断边缘。</small>
          </div>}
          <label className="ui-field-label">名称</label><input className="ui-property-input" value={selectedAsset.name} onChange={(event) => updateAsset(selectedAsset.id, { name: event.target.value })}/>
          <label className="ui-field-label">类别</label><input className="ui-property-input" value={selectedAsset.category} onChange={(event) => updateAsset(selectedAsset.id, { category: event.target.value })}/>
          <label className="ui-field-label">逻辑父图层</label><select className="ui-select" value={selectedAsset.parentId || ''} onChange={(e) => updateAsset(selectedId, { parentId: e.target.value })}><option value="">根层级</option>{project.assets.filter((a) => a.id !== selectedId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <label className="ui-check-label"><input type="checkbox" checked={selectedAsset.enabled !== false} onChange={(e) => updateAsset(selectedId, { enabled: e.target.checked })}/>保留为独立素材</label>
          <div className="ui-coordinate-row"><span>x <input type="number" value={selectedAsset.bounds.x} onChange={(event) => updateAsset(selectedAsset.id, (asset) => ({ bounds: { ...asset.bounds, x: Math.max(0, Math.min(project.width - asset.bounds.width, Number(event.target.value) || 0)) } }))}/></span><span>y <input type="number" value={selectedAsset.bounds.y} onChange={(event) => updateAsset(selectedAsset.id, (asset) => ({ bounds: { ...asset.bounds, y: Math.max(0, Math.min(project.height - asset.bounds.height, Number(event.target.value) || 0)) } }))}/></span></div>
          <div className="ui-coordinate-row"><span>w <input type="number" min="2" value={selectedAsset.bounds.width} onChange={(event) => updateAsset(selectedAsset.id, (asset) => ({ bounds: { ...asset.bounds, width: Math.max(2, Math.min(project.width - asset.bounds.x, Number(event.target.value) || 2)) } }))}/></span><span>h <input type="number" min="2" value={selectedAsset.bounds.height} onChange={(event) => updateAsset(selectedAsset.id, (asset) => ({ bounds: { ...asset.bounds, height: Math.max(2, Math.min(project.height - asset.bounds.y, Number(event.target.value) || 2)) } }))}/></span></div>
          <div className="ui-mode-tabs"><button onClick={layers.refineBounds}>AI 校正局部框</button><button disabled={!layers.status?.modelReady} onClick={() => { setShowOriginal(false); layers.segment([selectedId]); }}>分割本层</button><button disabled={!layers.status?.modelReady} onClick={() => { setShowOriginal(false); layers.segment([selectedId], 'local'); }}>局部精细分割</button></div>
          {selectedAsset.maskStale && <p className="ui-helper-copy">范围已修改，原蒙版没有拉伸；请重新分割。</p>}
          {selectedAsset.maskCandidates?.length > 0 && <><label className="ui-field-label">蒙版候选（评分仅供比较）</label><select className="ui-select" value={selectedAsset.maskAssetId} onChange={(e) => { const c = selectedAsset.maskCandidates.find((c) => c.maskAssetId === e.target.value); updateAsset(selectedId, { maskAssetId: c.maskAssetId, maskBounds: c.maskBounds, maskStrokes: [], maskRedo: [], maskStale: false }); }}>{selectedAsset.maskCandidates.map((c, i) => <option key={c.maskAssetId} value={c.maskAssetId}>候选 {i + 1} · {c.modelScore.toFixed(3)}{c.warnings?.length ? ' · 需留意' : ''}</option>)}</select></>}
          <span className="ui-field-label">导出形状</span><div className="ui-mode-tabs compact"><button className={selectedAsset.extractionMode !== 'mask' ? 'active' : ''} onClick={() => { updateAsset(selectedAsset.id, { extractionMode: 'rect' }); setMaskTool(''); }}>矩形裁切</button><button className={selectedAsset.extractionMode === 'mask' ? 'active' : ''} onClick={() => updateAsset(selectedAsset.id, { extractionMode: 'mask' })}>透明轮廓</button></div>
          {selectedAsset.extractionMode === 'mask' && <div className="ui-mask-tools"><div className="ui-mask-tool-buttons"><button className={maskTool === 'add' ? 'active' : ''} onClick={() => { setShowOriginal(false); layers.setView('layer'); setMaskTool(maskTool === 'add' ? '' : 'add'); }}>画笔</button><button className={maskTool === 'erase' ? 'active' : ''} onClick={() => { setShowOriginal(false); layers.setView('layer'); setMaskTool(maskTool === 'erase' ? '' : 'erase'); }}>擦除</button></div><label>笔刷 <input type="range" min="2" max="64" value={brushRadius} onChange={(event) => setBrushRadius(Number(event.target.value))}/><b>{brushRadius}px</b></label><small>{selectedAsset.maskAssetId ? '按原图像素增减蒙版，默认不羽化。改动后需重新确认。' : selectedAsset.polygon?.length >= 3 ? '旧项目的多边形蒙版已保留，可用本机分割替换。' : '尚无像素蒙版，请先分割本层，或用画笔选入区域。'}</small></div>}
          {selectedAsset.extractionMode === 'mask' && <div className="ui-mode-tabs"><button disabled={!selectedAsset.maskStrokes?.length} onClick={() => updateAsset(selectedId, (a) => ({ maskStrokes: a.maskStrokes.slice(0, -1), maskRedo: [...(a.maskRedo || []), a.maskStrokes.at(-1)] }))}>撤销笔刷</button><button disabled={!selectedAsset.maskRedo?.length} onClick={() => updateAsset(selectedId, (a) => ({ maskStrokes: [...(a.maskStrokes || []), a.maskRedo.at(-1)], maskRedo: a.maskRedo.slice(0, -1) }))}>重做笔刷</button></div>}
          {project.pipelineVersion === 2 && <button className={`ui-confirm-button ${selectedAsset.reviewed ? 'confirmed' : ''}`} disabled={selectedAsset.maskStale || !layers.selectedLayer?.bounds} onClick={() => setProject((p) => ({ ...p, approved: false, assets: p.assets.map((a) => a.id === selectedId ? { ...a, reviewed: true } : a) }))}>{selectedAsset.reviewed ? '本层已确认' : '确认本层边缘'}</button>}
          {selectedAsset.notes && <p className="ui-asset-note">AI 备注：{selectedAsset.notes}</p>}
        </div>}
        <div className="ui-export-panel">
          <button className={`ui-confirm-button ${project.approved ? 'confirmed' : ''}`} disabled={!project.assets.length || Boolean(busy)} onClick={confirmSplit}><Icon name="check"/>{project.approved ? '拆分方案已确认' : '确认拆分方案'}</button>
          <button className="ui-export-button" disabled={!project.approved || Boolean(busy)} onClick={() => exportPackage(false)}><Icon name="zip"/>导出独立素材 ZIP</button>
          <button className="ui-export-button dark" disabled={!project.approved || Boolean(busy)} onClick={() => exportPackage(true)}><Icon name="arrow"/>导出 Unity UGUI ZIP</button>
          {preparedExport && <a className="ui-download-ready ui-export-button" href={preparedExport.url} download={preparedExport.name}>下载刚生成的 ZIP</a>}
          <small>Unity 包含 Canvas、CanvasScaler 和图片层 Prefab 导入脚本；文字保持为图片。</small>
        </div>
      </aside>
    </div>
    {(busy || error || serverOffline) && <div className={`ui-status-message ${error || serverOffline ? 'error' : ''}`}>{error || (serverOffline ? '本机 AI 服务未启动；可先导入图片并调整标注。' : busy)}</div>}
  </main>;
}
