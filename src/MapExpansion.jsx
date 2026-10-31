import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useMapEngine from './map/useMapEngine.js';
import { assetFor, batchTargets, collisionCellIndex, gridCoordinateLabels, DIRECTIONS, ISO_PROMPT, mapGridCellPolygon, mapGridGeometry, mapWorkspaceBounds, pointInPolygon, polygonBounds, PROVIDERS, REGION_COLORS, REGION_TYPES, tileRect } from './map/core.js';
import { download, exportLayers, exportPng, exportProject, exportPsd, safeName } from './map/exports.js';
import { GRID_LAYOUTS, gridCellAtPoint, gridCellPolygon, gridLinesPath, normalizeGrid, traceGridCells } from './gridGeometry.js';
import { CharacterPreview, ScaleReferencePanel } from './map/ScaleReference.jsx';
import DirectLayerControls from './map/DirectLayerControls.jsx';
import { validLayerPair } from './map/layers.js';
import { geminiResolutions, resolutionLabel } from './map/geminiResolution.js';
import { assetImage, canvas } from './map/images.js';
import { createRegionAnalysisImage } from './map/regionAnalysis.js';
import { emptyPolygonDraft, polygonDraftAction, nearPolygonStart } from './map/regionDrawing.js';
import ReferenceControls, { ReferenceSummary } from './map/ReferenceControls.jsx';
import PromptInspector from './map/PromptInspector.jsx';
import './map/map.css';

const MIN_ZOOM = 0.001, MAX_ZOOM = 3;

function useAsset(id, assets) {
  const [url, setUrl] = useState('');
  useEffect(() => { let live = true; setUrl(''); if (id) assets.url(id).then((value) => live && setUrl(value)).catch(() => {}); return () => { live = false; }; }, [id, assets]);
  return url;
}
function AssetImg({ id, assets, alt = '', ...props }) { const url = useAsset(id, assets); return url ? <img src={url} alt={alt} {...props}/> : null; }
function SvgAsset({ id, assets, width, height }) { const url = useAsset(id, assets); return url ? <image href={url} width={width} height={height} preserveAspectRatio="none"/> : null; }
function MatteOverlay({ tile, assets, maskCanvas, revision, threshold }) {
  const storedUrl = useAsset(tile.layerDraft?.rawMaskId || tile.rawMaskId, assets), [url, setUrl] = useState('');
  useEffect(() => {
    if (!maskCanvas) { setUrl(storedUrl); return; }
    let live = true, objectUrl = '';
    maskCanvas.toBlob((blob) => {
      if (!live || !blob) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }, 'image/png');
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [maskCanvas, revision, storedUrl]);
  if (!url) return null;
  const id = `matte-overlay-${tile.id}`, filterId = `${id}-threshold`;
  return <svg className="mx-mask-overlay" width="100%" height="100%" viewBox={`0 0 ${tile.width} ${tile.height}`} aria-hidden="true">
    <defs><filter id={filterId} colorInterpolationFilters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="255" intercept={.5 - threshold}/><feFuncG type="linear" slope="255" intercept={.5 - threshold}/><feFuncB type="linear" slope="255" intercept={.5 - threshold}/></feComponentTransfer></filter><mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width={tile.width} height={tile.height} style={{ maskType: 'luminance' }}><image href={url} width={tile.width} height={tile.height} preserveAspectRatio="none" filter={`url(#${filterId})`}/></mask></defs>
    <rect width={tile.width} height={tile.height} fill="#ff367b" fillOpacity=".48" mask={`url(#${id})`}/>
  </svg>;
}
function TileView({ tile, project, assets, index, view, previewDraft, selected, maskOverlay, maskCanvas, maskRevision, maskThreshold }) {
  const r = tileRect(project, tile), draft = previewDraft ? tile.layerDraft : null;
  const original = tile.originalId, ground = draft ? draft.groundId : tile.groundId || original, objects = draft ? draft.objectsId : tile.objectsId;
  const ids = view === 'original' ? [original] : view === 'ground' ? [ground] : view === 'objects' ? [objects] : [project.visibility.ground && ground, project.visibility.objects && objects];
  const maskId = `owner-${tile.id}`;
  return <div className={`mx-tile ${selected ? 'selected' : ''}`} style={{ left: r.x, top: r.y, width: r.width, height: r.height }}>
    <svg width="100%" height="100%" viewBox={`0 0 ${r.width} ${r.height}`} aria-label={tile.name || '地图块'}>
      <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={r.width} height={r.height}><rect width={r.width} height={r.height} fill="white"/>{project.tiles.slice(0, index).map((t) => { const prior = tileRect(project, t); return <rect key={t.id} x={prior.x - r.x} y={prior.y - r.y} width={prior.width} height={prior.height} fill="black"/>; })}</mask></defs>
      <g mask={`url(#${maskId})`}>{ids.filter(Boolean).map((id, i) => <SvgAsset key={`${id}-${i}`} id={id} assets={assets} width={r.width} height={r.height}/>)}</g>
    </svg>
    {maskOverlay && <MatteOverlay tile={tile} assets={assets} maskCanvas={maskCanvas} revision={maskRevision} threshold={maskThreshold}/>}
  </div>;
}
function Field({ label, children, className = '' }) { return <label className={`mx-field ${className}`}><span>{label}</span>{children}</label>; }
function Button({ children, primary = false, ...props }) { return <button className={`mx-button ${primary ? 'primary' : ''}`} {...props}>{children}</button>; }

function GridNumberField({ label, ariaLabel, min, max, value, disabled, onChange, pixels = false, title }) {
  const [input, setInput] = useState(String(value));
  useEffect(() => setInput(String(value)), [value]);
  const commit = () => {
    const parsed = input.trim() ? Number(input) : value;
    const next = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : value;
    setInput(String(next)); onChange(next);
  };
  return <label className={pixels ? 'mx-grid-cell-field' : ''} title={title}>
    <span>{label}</span><input aria-label={ariaLabel} type="number" min={min} max={max} value={input} disabled={disabled} onChange={(event) => {
      const text = event.target.value, number = Number(text);
      setInput(text);
      if (text && Number.isInteger(number) && number >= min && number <= max) onChange(number);
    }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}/>{pixels && <small>px</small>}
  </label>;
}

export default function MapExpansion({ config, serverOffline, onOpenSettings, onNotify }) {
  const notify = useCallback((message) => onNotify(message), [onNotify]);
  const engine = useMapEngine({ config, serverOffline, onOpenSettings, notify });
  const { project: p, assets, selectedTile: tile, selectedRegion: selectedRegion, locked, busy, pending } = engine;
  const [tab, setTab] = useState('generate'), [direction, setDirection] = useState('e'), [view, setView] = useState('composite');
  const [pan, setPan] = useState({ x: 50, y: 40 }), [zoom, setZoom] = useState(.5), [cards, setCards] = useState(true), [previewDraft, setPreviewDraft] = useState(true);
  const [gridCoordinates, setGridCoordinates] = useState(false);
  const [tool, setTool] = useState('select'), [shape, setShape] = useState('rectangle'), [regionType, setRegionType] = useState('collision');
  const currentTypeRegions = p.regions.filter((r) => r.type === regionType);
  const region = selectedRegion?.type === regionType ? selectedRegion : null;
  const [drawPoints, setDrawPoints] = useState([]), [movedRegion, setMovedRegion] = useState(null), [retouchPoints, setRetouchPoints] = useState([]), [retouchPrompt, setRetouchPrompt] = useState('修复此区域，保持周边地图风格并自然衔接。');
  const [polygonDraft, setPolygonDraft] = useState(emptyPolygonDraft), polygonDraftRef = useRef(emptyPolygonDraft());
  const [closeHint, setCloseHint] = useState(false), lastPolygonSubmit = useRef(null);
  const editPolygon = (action, point) => { const next = polygonDraftAction(polygonDraftRef.current, action, point); polygonDraftRef.current = next; setPolygonDraft(next); setCloseHint(false); };
  const cancelDrawing = () => { lastPolygonSubmit.current = null; editPolygon('cancel'); setDrawPoints([]); gesture.current = null; setMovedRegion(null); };
  const localPolygon = tool === 'draw' && shape === 'polygon' && regionType !== 'collision' && tab === 'regions';
  const localSession = localPolygon && polygonDraft.active;
  const canUndoAction = !locked && (localSession ? polygonDraft.points.length > 0 : engine.canUndo);
  const canRedoAction = !locked && (localSession ? polygonDraft.redo.length > 0 : engine.canRedo);
  const undoAction = () => { if (locked) return; if (localPolygon && polygonDraftRef.current.active) editPolygon('undo'); else engine.undo(); };
  const redoAction = () => { if (locked) return; if (localPolygon && polygonDraftRef.current.active) editPolygon('redo'); else engine.redo(); };
  const [collisionStrokePreview, setCollisionStrokePreview] = useState(null);
  const [regionAnalysisProvider, setRegionAnalysisProvider] = useState(p.provider === 'kling' ? 'gemini' : p.provider);
  const [regionAnalysisBusy, setRegionAnalysisBusy] = useState('');
  const [regionAnalysis, setRegionAnalysis] = useState(null);
  const [batchWidth, setBatchWidth] = useState(3), [batchHeight, setBatchHeight] = useState(3), [concurrency, setConcurrency] = useState(1);
  const [projects, setProjects] = useState(null), [layerView, setLayerView] = useState('objects'), [layerBg, setLayerBg] = useState('checker');
  const [maskEditing, setMaskEditing] = useState(false), [maskPaintMode, setMaskPaintMode] = useState('add');
  const [maskBrushSize, setMaskBrushSize] = useState(36), [maskThreshold, setMaskThreshold] = useState(128), [maskFeather, setMaskFeather] = useState(1);
  const [maskCanvasRevision, setMaskCanvasRevision] = useState(0), maskEditor = useRef(null);
  const [exporting, setExporting] = useState('');
  const characterRef = useRef(null), [walking, setWalking] = useState(false);
  const viewport = useRef(null), gesture = useRef(null), space = useRef(false), state = useRef({ pan, zoom, p, drawPoints });
  const fileRef = useRef(null), styleRef = useRef(null), zipRef = useRef(null), replaceRef = useRef(false);
  state.current = { pan, zoom, p, drawPoints };
  const dir = DIRECTIONS.find((d) => d.id === direction), target = tile ? { x: tile.x + dir.dx, y: tile.y + dir.dy } : null;
  const occupied = target && p.tiles.some((t) => t.x === target.x && t.y === target.y);
  const matchingWork = p.work && target && p.work.target.x === target.x && p.work.target.y === target.y;
  const batch = useMemo(() => tile ? batchTargets(p, tile, batchWidth, batchHeight) : [], [p.tiles, p.tileWidth, p.tileHeight, tile?.id, batchWidth, batchHeight]);
  const draft = tile?.layerDraft || (tile?.objectsId || tile?.groundId ? tile : null);
  const rawMaskId = tile?.layerDraft?.rawMaskId || tile?.rawMaskId || '';
  const resolutions = p.provider === 'gemini' ? geminiResolutions(config.models?.gemini || '') : config.mapCapabilities?.[p.provider]?.resolutions || ({ openai: ['native'], qwen: ['native', '1K', '2K'], kling: ['native', '1K', '2K'] })[p.provider];
  const previewProject = useMemo(() => pending ? { ...p, tiles: pending.mode === 'replace' ? p.tiles.map((t) => t.id === pending.tile.id ? pending.tile : t) : [...p.tiles, pending.tile] } : p, [p, pending]);
  const grid = useMemo(() => normalizeGrid(p.grid), [p.grid]);
  const gridGeometry = useMemo(() => mapGridGeometry(p), [p.grid, p.tiles, p.tileWidth, p.tileHeight, p.overlapX, p.overlapY]);
  const gridMetrics = gridGeometry.metrics;
  const gridPath = useMemo(() => gridLinesPath(grid, gridMetrics), [grid, gridMetrics]);
  const gridLabels = useMemo(() => gridCoordinateLabels(grid), [grid]);
  const showGridLabels = gridCoordinates && grid.visible && grid.cellWidthPx * zoom >= 36 && grid.cellHeightPx * zoom >= 16;
  const collisionRegion = p.regions.find((r) => r.type === 'collision');
  const visibleCollisionCells = collisionStrokePreview ?? collisionRegion?.cells ?? [];
  const regionAnalysisSourceKey = JSON.stringify([p.grid, p.overlapX, p.overlapY, p.tiles.map((item) => [item.id, item.x, item.y, item.originalId, item.groundId, item.objectsId])]);
  const currentRegionAnalysis = regionAnalysis?.sourceKey === regionAnalysisSourceKey ? regionAnalysis : null;
  const collisionEdit = tab === 'regions' && regionType === 'collision';
  const canvasBounds = useMemo(() => mapWorkspaceBounds({ ...previewProject, grid: { ...grid, visible: true } }), [previewProject, grid]);
  const updateGrid = (change) => engine.patch({ grid: normalizeGrid({ ...engine.ref.current.grid, ...change }) });
  const analyzeRegions = async (kind) => {
    if (locked || !p.tiles.length || regionAnalysisBusy) return;
    if (!['openai', 'gemini', 'qwen'].includes(regionAnalysisProvider) || !config.configured[regionAnalysisProvider]) {
      setRegionAnalysis({ kind, sourceKey: regionAnalysisSourceKey, error: `请先在服务设置中配置${({ openai: 'OpenAI', gemini: 'Gemini', qwen: '千问' })[regionAnalysisProvider] || '所选'}提示词服务的 API key。` });
      return;
    }
    if (kind === 'occlusion' && p.tiles.some((item) => !item.objectsId)) {
      setRegionAnalysis({ kind, sourceKey: regionAnalysisSourceKey, error: '遮挡识别需要每个地图块都已有透明物件层。请先在“分层”中生成并接纳物件层，或导入透明 PNG。' });
      return;
    }
    setRegionAnalysisBusy(kind); setRegionAnalysis(null);
    try {
      const image = await createRegionAnalysisImage(p, assets, kind, gridLabels, gridMetrics);
      const response = await fetch('/api/map/regions/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        task: kind, provider: regionAnalysisProvider, imageBase64: image.imageBase64, imageMimeType: image.imageMimeType,
        imageWidth: image.imageWidth, imageHeight: image.imageHeight, rows: grid.height, columns: grid.width, layout: grid.layout,
      }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '自动识别失败。');
      const analysis = payload.analysis || {};
      if (kind === 'collision') {
        const unique = new Map();
        for (const item of Array.isArray(analysis.cells) ? analysis.cells : []) {
          const row = Number(item.row), col = Number(item.col);
          if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= grid.height || col >= grid.width) continue;
          const { x, y } = collisionCellIndex(grid, row, col), key = `${x},${y}`;
          unique.set(key, { x, y, row, col, confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)), reason: String(item.reason || '') });
        }
        const uncertain = (Array.isArray(analysis.uncertain) ? analysis.uncertain : []).filter((item) => Number.isInteger(Number(item.row)) && Number.isInteger(Number(item.col)) && Number(item.row) >= 0 && Number(item.col) >= 0 && Number(item.row) < grid.height && Number(item.col) < grid.width);
        setRegionAnalysis({ kind, sourceKey: regionAnalysisSourceKey, cells: [...unique.values()], uncertain });
      } else {
        const regions = (Array.isArray(analysis.regions) ? analysis.regions : []).slice(0, 40).map((item, index) => {
          const normalized = Array.isArray(item.polygon) ? item.polygon.slice(0, 12).map((point) => Array.isArray(point) ? point : []) : [];
          if (normalized.length < 3 || normalized.some((point) => point.length < 2 || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1])))) return null;
          const points = normalized.map(([x, y]) => ({ x: image.bounds.x + Math.max(0, Math.min(1000, Number(x))) / 1000 * image.bounds.width, y: image.bounds.y + Math.max(0, Math.min(1000, Number(y))) / 1000 * image.bounds.height }));
          const baselineNormalized = Number(item.baselineY), baselineY = image.bounds.y + Math.max(0, Math.min(1000, Number.isFinite(baselineNormalized) ? baselineNormalized : Math.max(...normalized.map((point) => Number(point[1]))))) / 1000 * image.bounds.height;
          return { name: String(item.name || `遮挡区 ${index + 1}`).slice(0, 100), points, baseline: baselineY, confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)), reason: String(item.reason || '') };
        }).filter(Boolean);
        setRegionAnalysis({ kind, sourceKey: regionAnalysisSourceKey, regions, uncertain: Array.isArray(analysis.uncertain) ? analysis.uncertain.slice(0, 12).map(String) : [] });
      }
    } catch (error) {
      setRegionAnalysis({ kind, sourceKey: regionAnalysisSourceKey, error: error?.message || '自动识别失败。' });
    } finally { setRegionAnalysisBusy(''); }
  };
  const applyCollisionAnalysis = (replace = false) => {
    if (currentRegionAnalysis?.kind !== 'collision') return;
    const detected = currentRegionAnalysis.cells.map(({ x, y }) => ({ x, y }));
    const cells = replace ? detected : [...(collisionRegion?.cells || []), ...detected];
    engine.setCollisionCells([...new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell])).values()]); setRegionAnalysis(null);
    notify(replace ? '已替换碰撞格标记。' : '已合并自动识别的碰撞格。');
  };
  const applyOcclusionAnalysis = () => {
    if (currentRegionAnalysis?.kind !== 'occlusion') return;
    const added = engine.addRegions(currentRegionAnalysis.regions.map((item) => ({ type: 'occlusion', name: item.name, points: item.points, baseline: item.baseline })));
    if (added.length) { setRegionAnalysis(null); notify(`已添加 ${added.length} 个遮挡区，可继续调整轮廓和排序线。`); }
  };
  const zoomTo = (value) => {
    const current = state.current, box = viewport.current?.getBoundingClientRect();
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    if (box) setPan({ x: box.width / 2 - (box.width / 2 - current.pan.x) * next / current.zoom, y: box.height / 2 - (box.height / 2 - current.pan.y) * next / current.zoom });
    setZoom(next);
  };
  useEffect(() => { setRegionAnalysisProvider(p.provider === 'kling' ? 'gemini' : p.provider); setRegionAnalysis(null); }, [p.provider]);
  const fit = useCallback(() => {
    if (!viewport.current) return;
    const b = mapWorkspaceBounds(engine.ref.current), box = viewport.current.getBoundingClientRect(), z = Math.max(MIN_ZOOM, Math.min(.85, (box.width - 100) / b.width, (box.height - 110) / b.height));
    setZoom(z); setPan({ x: (box.width - b.width * z) / 2 - b.x * z, y: (box.height - b.height * z) / 2 - b.y * z });
  }, [engine.ref]);
  const focusCharacter = () => {
    const point = characterRef.current?.position(), box = viewport.current?.getBoundingClientRect();
    if (!point || !box) return;
    setZoom(1); setPan({ x: box.width / 2 - point.x, y: box.height / 2 - point.y + p.scaleReference.heightPx / 2 });
  };
  useEffect(() => { characterRef.current?.stop(); }, [tab]);
  useEffect(() => { if (engine.ready) fit(); }, [engine.ready, p.id, p.tiles[0]?.id, p.tileWidth, p.tileHeight, fit]);
  useEffect(() => { if (draft?.layerMode === 'direct') setLayerView('objects'); }, [tile?.id, draft?.layerMode]);
  useEffect(() => { setMaskEditing(false); maskEditor.current = null; }, [tile?.id]);
  useEffect(() => {
    setMaskThreshold(tile?.layerDraft?.threshold ?? tile?.threshold ?? 128);
    setMaskFeather(tile?.layerDraft?.feather ?? tile?.feather ?? 1);
  }, [tile?.id, rawMaskId]);
  useEffect(() => {
    let current = true;
    if (!rawMaskId || !tile) { maskEditor.current = null; setMaskCanvasRevision((v) => v + 1); return () => { current = false; }; }
    assetImage(rawMaskId, assets).then((image) => {
      if (!current) return;
      const raw = canvas(tile.width, tile.height); raw.getContext('2d').drawImage(image, 0, 0, raw.width, raw.height);
      maskEditor.current = { tileId: tile.id, canvas: raw }; setMaskCanvasRevision((v) => v + 1);
    }).catch((error) => notify(`读取物件蒙版失败：${error.message}`));
    return () => { current = false; };
  }, [rawMaskId, tile?.id, tile?.width, tile?.height, assets, notify]);
  // All polygon completion paths use the synchronous draft ref, so double-click
  // events cannot append duplicate vertices or commit the same region twice.
  const finishPolygon = (completionPoint = null) => {
    if (!localPolygon || locked || !polygonDraftRef.current.active) return;
    const saved = engine.addRegion(regionType, polygonDraftRef.current.points);
    if (saved) { lastPolygonSubmit.current = completionPoint && Number.isFinite(completionPoint.x) ? { point: completionPoint, time: performance.now() } : null; editPolygon('cancel'); setDrawPoints([]); notify(`已保存「${saved.name}」，可继续绘制下一块。`); }
  };
  useEffect(() => { cancelDrawing(); }, [tab, tool, shape, regionType, p.id, p.tiles[0]?.id]);
  const finishCollisionStroke = () => {
    const stroke = gesture.current;
    if (stroke?.kind !== 'collision') return;
    gesture.current = null; setCollisionStrokePreview(null); engine.setCollisionCells([...stroke.cells.values()]);
  };
  useEffect(() => {
    const keydown = (event) => {
      if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); characterRef.current?.stop(); engine.save(); return; }
      if (walking) return;
      if (event.code === 'Space') { event.preventDefault(); space.current = true; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoAction() : undoAction(); return; }
      if (event.key === 'Enter' && localPolygon) { event.preventDefault(); finishPolygon(); }
      if (event.key === 'Escape') { if (gesture.current?.kind === 'collision') finishCollisionStroke(); else cancelDrawing(); setRetouchPoints([]); return; }
      if ((event.key === 'Backspace' || event.key === 'Delete') && localPolygon && polygonDraftRef.current.active) { event.preventDefault(); if (event.key === 'Backspace' && !locked) editPolygon('undo'); return; }
      if ((event.key === 'Delete' || event.key === 'Backspace') && region) { event.preventDefault(); engine.deleteRegion(); }
    };
    const keyup = (event) => { if (event.code === 'Space') space.current = false; };
    const blur = () => { space.current = false; if (gesture.current?.kind === 'collision') finishCollisionStroke(); else gesture.current = null; };
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); };
  });
  const worldPoint = (event) => { const b = viewport.current.getBoundingClientRect(), s = state.current; return { x: Math.round((event.clientX - b.left - s.pan.x) / s.zoom), y: Math.round((event.clientY - b.top - s.pan.y) / s.zoom) }; };
  const paintMaskSegment = (tileId, from, to) => {
    const target = maskEditor.current;
    if (!target || target.tileId !== tileId) return false;
    const ctx = target.canvas.getContext('2d'); ctx.save(); ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = maskPaintMode === 'add' ? '#fff' : '#000'; ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = maskBrushSize; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    if (from.x === to.x && from.y === to.y) { ctx.beginPath(); ctx.arc(from.x, from.y, maskBrushSize / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore(); return true;
  };
  const finishMaskStroke = () => { const target = maskEditor.current; if (target?.tileId === tile?.id) { setMaskCanvasRevision((v) => v + 1); engine.editMatte(target.canvas, maskThreshold, maskFeather); } };
  const collisionCellAt = (point) => gridCellAtPoint(grid, gridMetrics, { x: point.x - gridGeometry.x, y: point.y - gridGeometry.y });
  const paintCollisionSegment = (stroke, from, to) => {
    let changed = false;
    for (const cell of traceGridCells(from, to, stroke.grid, stroke.metrics, stroke.origin)) {
      const key = `${cell.x},${cell.y}`;
      if (stroke.visited.has(key)) continue;
      stroke.visited.add(key);
      if (stroke.mode === 'add') {
        if (!stroke.cells.has(key)) { stroke.cells.set(key, cell); changed = true; }
      } else if (stroke.cells.delete(key)) changed = true;
    }
    if (changed) setCollisionStrokePreview([...stroke.cells.values()]);
  };
  const pointerDown = (event) => {
    if (walking) { characterRef.current?.stop(); return; }
    if (event.button === 1 || event.button === 2 || space.current || (tool === 'pan' && !collisionEdit && !maskEditing)) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, pan: state.current.pan }; return; }
    if (event.button !== 0 || locked) return;
    const point = worldPoint(event);
    if (maskEditing && tile) {
      const rect = tileRect(p, tile), local = { x: point.x - rect.x, y: point.y - rect.y };
      if (local.x < 0 || local.y < 0 || local.x >= tile.width || local.y >= tile.height || !maskEditor.current || maskEditor.current.tileId !== tile.id) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { kind: 'mask', tileId: tile.id, last: local };
      paintMaskSegment(tile.id, local, local); return;
    }
    if (collisionEdit) {
      const cell = collisionCellAt(point); if (!cell) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      const cells = new Map((collisionRegion?.cells || []).map((value) => [`${value.x},${value.y}`, value])), key = `${cell.x},${cell.y}`;
      const stroke = { kind: 'collision', mode: cells.has(key) ? 'erase' : 'add', cells, visited: new Set(), last: point, grid, metrics: gridMetrics, origin: { x: gridGeometry.x, y: gridGeometry.y } };
      gesture.current = stroke; paintCollisionSegment(stroke, point, point); return;
    }
    if (localPolygon) {
      event.preventDefault();
      const recent = lastPolygonSubmit.current;
      if (event.detail > 1 || recent && performance.now() - recent.time < 500 && Math.hypot(point.x - recent.point.x, point.y - recent.point.y) * zoom <= 10) return;
      if (nearPolygonStart(polygonDraftRef.current.points, point, zoom)) finishPolygon(point);
      else editPolygon('add', point);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === 'draw' || tool === 'retouch') { gesture.current = { kind: tool, start: point }; setDrawPoints([point]); return; }
    const hitRegion = [...p.regions].reverse().find((r) => r.type === regionType && r.type !== 'collision' && r.visible !== false && r.points?.length >= 3 && pointInPolygon(point, r.points));
    if (hitRegion && tab === 'regions') { engine.setSelectedRegionId(hitRegion.id); gesture.current = { kind: 'region', start: point, region: hitRegion }; return; }
    const hitTile = p.tiles.find((t) => { const r = tileRect(p, t); return point.x >= r.x && point.y >= r.y && point.x < r.x + r.width && point.y < r.y + r.height; });
    if (hitTile) { engine.setSelectedId(hitTile.id); engine.setSelectedRegionId(''); }
  };
  const pointerMove = (event) => {
    const g = gesture.current;
    if (localPolygon && !g) setCloseHint(nearPolygonStart(polygonDraftRef.current.points, worldPoint(event), zoom));
    if (!g) return;
    if (g.kind === 'pan') { setPan({ x: g.pan.x + event.clientX - g.start.x, y: g.pan.y + event.clientY - g.start.y }); return; }
    const point = worldPoint(event);
    if (g.kind === 'mask') {
      const activeTile = state.current.p.tiles.find((item) => item.id === g.tileId) || tile;
      if (!activeTile) return;
      const rect = tileRect(state.current.p, activeTile);
      const local = { x: Math.max(0, Math.min(rect.width, point.x - rect.x)), y: Math.max(0, Math.min(rect.height, point.y - rect.y)) };
      paintMaskSegment(g.tileId, g.last, local); g.last = local; return;
    }
    if (g.kind === 'collision') { paintCollisionSegment(g, g.last, point); g.last = point; return; }
    if (g.kind === 'region') { const dx = point.x - g.start.x, dy = point.y - g.start.y; setMovedRegion({ ...g.region, points: g.region.points.map((p) => ({ x: p.x + dx, y: p.y + dy })), baseline: g.region.baseline + dy }); }
    else if (shape === 'free' && g.kind !== 'retouch') setDrawPoints((pts) => pts.length < 600 && Math.hypot(point.x - pts[pts.length - 1].x, point.y - pts[pts.length - 1].y) > 3 / zoom ? [...pts, point] : pts);
    else setDrawPoints([g.start, { x: point.x, y: g.start.y }, point, { x: g.start.x, y: point.y }]);
  };
  const pointerUp = () => {
    const g = gesture.current; if (g?.kind === 'collision') { finishCollisionStroke(); return; }
    gesture.current = null; if (!g || g.kind === 'pan') return;
    if (g.kind === 'mask') { finishMaskStroke(); return; }
    if (g.kind === 'region') { if (movedRegion) engine.updateRegion(g.region.id, { points: movedRegion.points, baseline: movedRegion.baseline }); setMovedRegion(null); return; }
    const points = state.current.drawPoints;
    if (g.kind === 'retouch' && (points.length < 3 || polygonBounds(points).width * polygonBounds(points).height < 8)) { setDrawPoints([]); return; }
    if (g.kind === 'retouch') { setRetouchPoints(points); setDrawPoints([]); setTab('generate'); }
    else { const saved = engine.addRegion(regionType, points); if (saved) { setDrawPoints([]); setTab('regions'); notify(`已保存「${saved.name}」，可继续绘制下一块。`); } }
  };
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const wheel = (e) => { e.preventDefault(); const s = state.current, b = element.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); setZoom(next); setPan({ x: x - (x - s.pan.x) * next / s.zoom, y: y - (y - s.pan.y) * next / s.zoom }); };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, []);
  const openProjects = async () => { try { setProjects(await engine.listProjects()); } catch (e) { notify(e.message); } };
  const doExport = async (kind) => {
    if (!p.tiles.length || exporting) return; characterRef.current?.stop(); setExporting(kind);
    try {
      const blob = kind === 'png' ? await exportPng(p, assets) : kind === 'psd' ? await exportPsd(p, assets) : kind === 'project' ? await exportProject(engine.ref.current, assets) : await exportLayers(p, assets, kind === 'unity');
      download(blob, `${safeName(p.name)}-${({ png: '合成', psd: '分层', project: '项目', layers: '分层素材', unity: 'Unity2D' })[kind]}.${kind === 'png' ? 'png' : kind === 'psd' ? 'psd' : 'zip'}`); notify('文件已导出。');
    } catch (e) { notify(e.message); } finally { setExporting(''); }
  };
  const downloadTile = async () => { if (tile) download(await assets.get(tile.originalId), `${safeName(tile.name)}.png`); };
  const visibleBox = viewport.current?.getBoundingClientRect();
  const inView = (t) => { if (!visibleBox) return true; const r = tileRect(previewProject, t), x = pan.x + r.x * zoom, y = pan.y + r.y * zoom; return x + r.width * zoom >= -120 && y + r.height * zoom >= -100 && x < visibleBox.width + 120 && y < visibleBox.height + 100; };
  const q = p.queue, done = q?.tasks.filter((t) => t.status === 'done').length || 0;
  const regionList = movedRegion ? p.regions.map((r) => r.id === movedRegion.id ? movedRegion : r) : p.regions;
  return <div className="mx-workbench">
    <div className="mx-projectbar">
      <div className="mx-project-title"><span className="mx-project-icon">▧</span><input aria-label="地图项目名称" value={p.name} disabled={locked} onChange={(e) => engine.patch({ name: e.target.value })}/><span className="mx-local-tag">本地草稿</span></div>
      <div className="mx-actions"><Button disabled={locked} onClick={engine.createNew}>＋ 新建</Button><Button disabled={locked} onClick={openProjects}>打开</Button><Button onClick={() => { characterRef.current?.stop(); engine.save(); }}>保存</Button><span className="mx-separator"/><Button disabled={!canUndoAction} onClick={undoAction} title="Ctrl / ⌘ Z">↶</Button><Button disabled={!canRedoAction} onClick={redoAction} title="Ctrl / ⌘ Shift Z">↷</Button><Button primary disabled={!p.tiles.length} onClick={() => setTab('export')}>导出资源 ↗</Button></div>
    </div>
    <div className="mx-layout">
      <aside className="mx-sidebar">
        <div className="mx-section-label">地图素材 <span>{p.tiles.length} 块</span></div>
        <button className="mx-import" disabled={locked} onClick={() => { replaceRef.current = false; fileRef.current.click(); }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!locked) engine.importBase(e.dataTransfer.files[0]); }}>
          {p.tiles[0] ? <AssetImg id={p.tiles[0].originalId} assets={assets} alt="底图缩略图"/> : <b>＋</b>}<strong>{p.tiles.length ? '重新导入底图' : '导入底图'}</strong><small>PNG · JPEG · WebP · 保留透明通道</small>
        </button>
        <input type="file" hidden ref={fileRef} accept="image/png,image/jpeg,image/webp" onChange={(e) => { const file = e.target.files[0]; if (file) engine.importBase(file, replaceRef.current); e.target.value = ''; }}/>
        <div className="mx-selected-meta">{tile ? <><b>{tile.name}</b><span>坐标 {tile.x}, {tile.y} · {tile.width} × {tile.height}</span>{tile.actualWidth && <span>服务实际输出 {tile.actualWidth} × {tile.actualHeight}</span>}</> : <span>导入图片或在右侧生成初始地图</span>}</div>
        <div className="mx-inline"><Button disabled={locked || !tile} onClick={() => { replaceRef.current = true; fileRef.current.click(); }}>替换选中块</Button><Button disabled={!tile} onClick={downloadTile}>下载</Button></div>
        <div className="mx-divider"/>
        <div className="mx-section-label">扩展方向 <span>八方向</span></div>
        <div className="mx-direction">{DIRECTIONS.map((d) => <button key={d.id} disabled={locked || !tile} className={direction === d.id ? 'active' : ''} style={{ gridColumn: d.dx + 2, gridRow: d.dy + 2 }} onClick={() => { setDirection(d.id); setTab('generate'); }} aria-label={`${d.label}方向`} title={d.label}>{d.arrow}</button>)}<span>✦</span></div>
        <div className="mx-divider"/>
        <div className="mx-section-label">图层视图</div>
        <div className="mx-segment">{[['composite', '整体'], ['ground', '地面'], ['objects', '物件'], ['original', '原图']].map(([v, label]) => <button className={view === v ? 'active' : ''} key={v} onClick={() => setView(v)}>{label}</button>)}</div>
        <div className="mx-visibility">{['ground', 'objects'].map((layer) => <label key={layer}><input type="checkbox" checked={p.visibility[layer]} disabled={locked} onChange={(e) => engine.patch({ visibility: { ...p.visibility, [layer]: e.target.checked } })}/>{layer === 'ground' ? '地面' : '物件'}可见</label>)}</div>
        <div className="mx-divider"/>
        <fieldset disabled={locked} className="mx-fieldset">
          <div className="mx-section-label">拼接设置</div>
          <Field label={`左右重叠 ${p.overlapX}%`}><input type="range" min="0" max="40" value={p.overlapX} onChange={(e) => engine.changeOverlap(+e.target.value, p.overlapY)}/></Field>
          <Field label={`上下重叠 ${p.overlapY}%`}><input type="range" min="0" max="40" value={p.overlapY} onChange={(e) => engine.changeOverlap(p.overlapX, +e.target.value)}/></Field>
          <Field label="生成细分"><select value={p.subdivisions} onChange={(e) => engine.patch({ subdivisions: +e.target.value })}><option value="1">整块 · 1 次生成</option><option value="2">2 × 2 · 4 次生成</option><option value="3">3 × 3 · 9 次生成</option></select></Field>
          <div className="mx-divider"/>
          <Field label="图像服务"><select value={p.provider} onChange={(e) => engine.patch({ provider: e.target.value, resolution: 'native' })}>{Object.entries(PROVIDERS).map(([key, label]) => <option key={key} value={key}>{label}{config.configured[key] ? ' · 已配置' : ' · 未配置'}</option>)}</select></Field>
          <Field label="服务输出尺寸"><select value={p.resolution} onChange={(e) => engine.patch({ resolution: e.target.value })}>{!resolutions.includes(p.resolution) && <option value={p.resolution} disabled>{resolutionLabel(p.resolution)} · 当前模型不支持</option>}{resolutions.map((r) => <option key={r} value={r}>{resolutionLabel(r)}</option>)}</select></Field>
          {!resolutions.includes(p.resolution) && <p className="mx-hint">当前模型不支持已保存的输出尺寸，请重新选择。</p>}
        </fieldset>
        <button className="mx-service-settings" onClick={onOpenSettings}>⚙ 服务设置 <span>{config.models[p.provider]}</span></button>
      </aside>
      <main className="mx-canvas-column">
        <div className="mx-canvas-toolbar">
          <div className="mx-canvas-heading">
            <div className="mx-inline"><b>地图画布</b><span>{grid.width} × {grid.height}</span><span className="mx-grid-alignment" title={`主图像素中心 (${gridGeometry.center.x}, ${gridGeometry.center.y})；图像坐标 X 向右、Y 向下。网格外框 ${gridGeometry.width} × ${gridGeometry.height} px。`}>{p.tiles.length ? '中心对齐主图' : '网格居中'}</span></div>
            <div className="mx-inline mx-canvas-tools">
              <button title="选择 / 移动区域" aria-label="选择 / 移动区域" className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>↖</button>
              <button title="拖动画布" aria-label="拖动画布" className={tool === 'pan' ? 'active' : ''} onClick={() => setTool('pan')}>✥</button>
              <button onClick={fit} title="适合画布" aria-label="适合画布">⛶</button>
              <button className={cards ? 'active' : ''} aria-pressed={cards} onClick={() => setCards(!cards)} title="显示 / 隐藏图块卡片" aria-label="显示 / 隐藏图块卡片">▤</button>
            </div>
          </div>
          <div className="mx-grid-controls">
            <GridNumberField label="宽" ariaLabel="画布宽度" title="格子列数；格内坐标为（行,列），与Unity导出一致" min={4} max={64} value={grid.width} disabled={locked} onChange={(value) => updateGrid({ width: value })}/>
            <GridNumberField label="高" ariaLabel="画布高度" title="格子行数" min={4} max={64} value={grid.height} disabled={locked} onChange={(value) => updateGrid({ height: value })}/>
            <GridNumberField label="Cell 宽" ariaLabel="Cell 宽度（像素）" min={1} max={4096} value={grid.cellWidthPx} pixels disabled={locked} onChange={(value) => updateGrid({ cellWidthPx: value })}/>
            <GridNumberField label="Cell 高" ariaLabel="Cell 高度（像素）" min={1} max={4096} value={grid.cellHeightPx} pixels disabled={locked} onChange={(value) => updateGrid({ cellHeightPx: value })}/>
            <select aria-label="网格布局" value={grid.layout} disabled={locked} onChange={(event) => updateGrid({ layout: event.target.value })}>{GRID_LAYOUTS.map((layout) => <option key={layout.id} value={layout.id}>{layout.label}</option>)}</select>
            {grid.layout === 'hexagon' && <select aria-label="六边形方向" value={grid.hexOrientation} disabled={locked} onChange={(event) => updateGrid({ hexOrientation: event.target.value })}><option value="pointy">Point Top</option><option value="flat">Flat Top</option></select>}
            <div className="mx-canvas-zoom" aria-label="画布缩放">
              <button title="缩小画布" aria-label="缩小画布" disabled={zoom <= MIN_ZOOM} onClick={() => zoomTo(zoom / 1.2)}>−</button>
              <button className="mx-zoom-reset" title="重置为 100%" aria-label="重置画布缩放" onClick={() => zoomTo(1)}>{Number((zoom * 100).toFixed(zoom < .1 ? 1 : 0))}%</button>
              <button title="放大画布" aria-label="放大画布" disabled={zoom >= MAX_ZOOM} onClick={() => zoomTo(zoom * 1.2)}>＋</button>
            </div>
            <button className={`mx-grid-toggle ${grid.visible ? 'active' : ''}`} aria-pressed={grid.visible} aria-label={`${grid.visible ? '隐藏' : '显示'}网格`} title={`${grid.visible ? '隐藏' : '显示'}网格`} disabled={locked} onClick={() => updateGrid({ visible: !grid.visible })}>▦ 网格</button>
            <button className={`mx-grid-toggle ${gridCoordinates ? 'active' : ''}`} aria-pressed={gridCoordinates} aria-label="网格坐标" title="显示或隐藏格子中心坐标；需要开启网格并放大至可读尺寸" onClick={() => setGridCoordinates((visible) => !visible)}>网格坐标</button>
            <button className={`mx-grid-toggle ${tab === 'scale' ? 'active' : ''}`} onClick={() => setTab('scale')}>♙ 角色比例</button>
          </div>
        </div>
        <div className={`mx-viewport tool-${tool} ${collisionEdit ? 'collision-edit' : ''} ${maskEditing ? 'mask-editing' : ''}`} ref={viewport} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { if (gesture.current?.kind === 'collision') finishCollisionStroke(); else { const wasMask = gesture.current?.kind === 'mask'; gesture.current = null; if (wasMask) finishMaskStroke(); } cancelDrawing(); }} onDoubleClick={(event) => { if (localPolygon) { event.preventDefault(); if (polygonDraftRef.current.points.length >= 3) finishPolygon(worldPoint(event)); } }} onPointerLeave={() => setCloseHint(false)} onContextMenu={(e) => e.preventDefault()}>
          {!p.tiles.length && <div className="mx-empty"><span>▧</span><h2>从一块地图，延伸整个世界</h2><p>导入底图，或填写描述生成初始地图</p><Button primary disabled={locked} onClick={() => fileRef.current.click()}>＋ 导入底图</Button></div>}
          <div className="mx-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            {previewProject.tiles.map((t, i) => inView(t) && <TileView key={t.id} tile={t} index={i} project={previewProject} assets={assets} view={view} previewDraft={previewDraft && t.id === tile?.id} selected={t.id === tile?.id} maskOverlay={maskEditing && t.id === tile?.id && tab === 'layers'} maskCanvas={t.id === tile?.id ? maskEditor.current?.canvas : null} maskRevision={maskCanvasRevision} maskThreshold={maskThreshold}/>)}
            {(grid.visible || collisionEdit) && <svg className="mx-grid-overlay" style={{ left: gridGeometry.x, top: gridGeometry.y, width: gridMetrics.boardWidth, height: gridMetrics.boardHeight }} viewBox={`0 0 ${gridMetrics.boardWidth} ${gridMetrics.boardHeight}`} data-layout={grid.layout} data-columns={grid.width} data-rows={grid.height} aria-label="地图扩张格子布局" aria-hidden="true"><path className="mx-grid-halo" d={gridPath}/><path className="mx-grid-lines" d={gridPath}/>{showGridLabels && <g className="mx-grid-coordinates" fontSize={Math.min(11, grid.cellHeightPx * zoom * .36) / zoom}>{gridLabels.filter((label) => {
              const x = pan.x + (gridGeometry.x + label.x) * zoom, y = pan.y + (gridGeometry.y + label.y) * zoom;
              return !visibleBox || x >= -40 && y >= -15 && x <= visibleBox.width + 40 && y <= visibleBox.height + 15;
            }).map((label) => <text key={label.key} x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central" data-row={label.row} data-col={label.col}>{`(${label.row},${label.col})`}</text>)}</g>}</svg>}
            {tab === 'auto' && !engine.pumpActive && batch.map((t) => { const r = tileRect(p, t); return <div className="mx-ghost" key={`${t.x},${t.y}`} style={{ left: r.x, top: r.y, width: r.width, height: r.height }}><span style={{ fontSize: 12 / zoom }}>{t.x}, {t.y}</span></div>; })}
            <svg className="mx-regions-svg" style={{ left: canvasBounds.x, top: canvasBounds.y, width: canvasBounds.width, height: canvasBounds.height }} viewBox={`${canvasBounds.x} ${canvasBounds.y} ${canvasBounds.width} ${canvasBounds.height}`}>
              {tab === 'regions' && visibleCollisionCells.map((cell) => <polygon key={`collision-${cell.x},${cell.y}`} className="mx-collision-cell" points={mapGridCellPolygon(p, cell.x, cell.y).map((v) => `${v.x},${v.y}`).join(' ')}/>)}
              {tab === 'regions' && currentRegionAnalysis?.kind === 'collision' && currentRegionAnalysis.cells.map((cell) => <polygon key={`suggested-collision-${cell.x},${cell.y}`} className="mx-collision-suggestion" points={mapGridCellPolygon(p, cell.x, cell.y).map((v) => `${v.x},${v.y}`).join(' ')}/>)}
              {tab === 'regions' && currentRegionAnalysis?.kind === 'occlusion' && currentRegionAnalysis.regions.map((item, index) => { const bounds = polygonBounds(item.points); return <g key={`suggested-occlusion-${index}`} className="mx-occlusion-suggestion"><polygon points={item.points.map((v) => `${v.x},${v.y}`).join(' ')}/><line x1={bounds.x} x2={bounds.x + bounds.width} y1={item.baseline} y2={item.baseline}/><text x={bounds.x} y={bounds.y - 8 / zoom}>{item.name} · {Math.round(item.confidence * 100)}%</text></g>; })}
              {regionList.filter((r) => r.type !== 'collision' && r.visible !== false && r.points?.length >= 3).map((r) => <g key={r.id}><polygon points={r.points.map((v) => `${v.x},${v.y}`).join(' ')} fill={`${REGION_COLORS[r.type]}38`} stroke={REGION_COLORS[r.type]} strokeWidth={r.id === region?.id ? 3 : 1.5} vectorEffect="non-scaling-stroke"/>{r.id === region?.id && ['occlusion', 'top'].includes(r.type) && <line x1={polygonBounds(r.points).x} x2={polygonBounds(r.points).x + polygonBounds(r.points).width} y1={r.baseline} y2={r.baseline} stroke="#e9c53d" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke"/>}</g>)}
              {[localPolygon ? polygonDraft.points : drawPoints, retouchPoints].filter((points) => points.length).map((points, i) => <polyline key={i} points={points.map((v) => `${v.x},${v.y}`).join(' ')} fill="none" stroke="#839f37" strokeWidth="2" strokeDasharray="5 3" vectorEffect="non-scaling-stroke"/>)}
              {localPolygon && polygonDraft.points.length > 0 && <g className="mx-polygon-start">
                <circle cx={polygonDraft.points[0].x} cy={polygonDraft.points[0].y} r={(closeHint ? 10 : 6) / zoom} fill={closeHint ? '#d5f36b' : '#fff'} stroke="#627d26" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
                {closeHint && <text x={polygonDraft.points[0].x + 14 / zoom} y={polygonDraft.points[0].y - 12 / zoom} fontSize={12 / zoom} fill="#395a29">点击起点闭合并保存</text>}
              </g>}
            </svg>
            <CharacterPreview ref={characterRef} project={p} assets={assets} zoom={zoom} locked={locked} tool={tool} onCommit={(position) => engine.updateScaleReference({ position })} onWalkingChange={setWalking} notify={notify}/>
          </div>
          {cards && previewProject.tiles.filter(inView).map((t) => { const r = tileRect(previewProject, t); return <button key={t.id} disabled={locked} className={`mx-tile-card ${t.id === tile?.id ? 'selected' : ''}`} style={{ left: pan.x + (r.x + r.width / 2) * zoom, top: pan.y + r.y * zoom + 12 }} onPointerDown={(e) => e.stopPropagation()} onClick={() => engine.setSelectedId(t.id)}><strong>{t.id === pending?.tile.id ? '待接纳预览' : t.kind === 'base' ? '主图' : `${t.x}, ${t.y}`}</strong><span>{t.groundId ? '地面 / 物件已分层' : '整体图块'} · 点击选择</span></button>; })}
          {pending && <div className="mx-preview-bar" onPointerDown={(e) => e.stopPropagation()}><div><strong>{pending.mode === 'replace' ? '局部重绘预览' : '新图块预览'}</strong><span>目标 {pending.tile.x}, {pending.tile.y}</span></div><Button disabled={locked} onClick={engine.discard}>丢弃</Button><Button primary disabled={locked} onClick={engine.accept}>✓ 接纳图块</Button></div>}
          {busy && <div className="mx-busy-bar" onPointerDown={(e) => e.stopPropagation()}><span className="spinner"/><strong>{busy}</strong>{p.work && <span>{p.work.completedParts.length} / {p.subdivisions ** 2} 分段</span>}<Button onClick={engine.cancel}>停止</Button></div>}
        </div>
        <footer className="mx-canvas-footer"><span>{maskEditing ? `${maskPaintMode === 'add' ? '白笔添加' : '黑笔擦除'}蒙版 · ${maskBrushSize} px · 左键绘制 · 右键 / 空格拖动画布` : walking ? '试走中 · WASD / 方向键移动 · Esc 停止' : '右键 / 空格拖动 · 滚轮缩放'}{!maskEditing && !walking && tool === 'draw' && shape === 'polygon' ? ' · 点击加点／起点闭合，Enter 保存，Backspace 撤回点，Esc 取消' : ''}</span><span>{grid.visible ? `${GRID_LAYOUTS.find((layout) => layout.id === grid.layout)?.label} · Cell ${grid.cellWidthPx} × ${grid.cellHeightPx} px · ` : ''}{q && ['running', 'pausing', 'paused'].includes(q.status) ? `自动扩图 ${done}/${q.tasks.length} · ${q.status === 'running' ? '生成中' : '已暂停'}` : tab === 'regions' ? regionType === 'collision' ? `${collisionRegion?.cells?.length || 0} 个碰撞格` : `${currentTypeRegions.length} 个${REGION_TYPES[regionType]}` : `${collisionRegion?.cells?.length || 0} 个碰撞格 · ${p.regions.filter((r) => r.type !== 'collision').length} 个区域`}</span></footer>
      </main>
      <aside className="mx-inspector">
        <nav className="mx-tabs">{[['generate', '生成'], ['prompts', '提示词'], ['rules', '全局规则'], ['scale', '比例'], ['auto', '自动'], ['layers', '分层'], ['regions', '区域'], ['export', '导出']].map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={tab === key ? 'active' : ''}>{label}</button>)}</nav>
        <div className="mx-inspector-content">
          {engine.error && <div className="mx-error" role="alert"><strong>操作未完成</strong><p>{engine.error}</p><button onClick={engine.clearError}>关闭提示</button></div>}
          {tab === 'rules' && <>
            <div className="mx-panel-heading"><small>GLOBAL MAP RULES</small><h2>全局规则</h2><p>仅用于当前地图项目，统一约束初始生成、主图重生成、扩图和局部重绘。分层继续使用专用提示词。</p></div>
            <fieldset className="mx-fieldset" disabled={locked}>
              <Field label="全局正向提示词"><textarea aria-label="地图全局正向提示词" rows="9" value={p.globalPositivePrompt || ''} onChange={(e) => engine.patch({ globalPositivePrompt: e.target.value })} placeholder="填写固定美术风格、镜头、配色和像素表现。"/></Field>
              <Field label="全局反向提示词"><textarea aria-label="地图全局反向提示词" rows="6" value={p.globalNegativePrompt || ''} onChange={(e) => engine.patch({ globalNegativePrompt: e.target.value })} placeholder="填写整个地图都应避免的内容。"/></Field>
            </fieldset>
            <p className="mx-hint">规则随项目与草稿保存，并包含在可编辑项目 ZIP 中。修改规则会清除旧分段缓存和待接纳预览。画布、网格、PPU和角色比例仍在各自面板设置。</p>
          </>}
          {tab === 'prompts' && <PromptInspector engine={engine} direction={dir} points={retouchPoints} prompt={retouchPrompt} notify={notify} initialOperation={p.tiles.length ? 'expand' : 'seed'}/>}
          {tab === 'scale' && <ScaleReferencePanel project={p} engine={engine} characterRef={characterRef} walking={walking} onFocus={focusCharacter} notify={notify}/>}
          {tab === 'generate' && <>
            <div className="mx-panel-heading"><small>AI MAP EXPANSION</small><h2>{p.tiles.length ? '向外延伸地图' : '生成初始地图'}</h2><p>{p.tiles.length ? `从选中图块向${dir.label}扩展，保留周围已有内容。` : '描述世界的风格和内容，创建第一块地图。'}</p></div>
            <fieldset className="mx-fieldset" disabled={locked}>
              {!p.tiles.length && <div className="mx-two"><Field label="地图宽度 px"><input type="number" min="128" max="4096" step="128" value={p.tileWidth} onChange={(e) => engine.patch({ tileWidth: Math.max(128, Math.min(4096, +e.target.value || 128)) })}/></Field><Field label="地图高度 px"><input type="number" min="128" max="4096" step="128" value={p.tileHeight} onChange={(e) => engine.patch({ tileHeight: Math.max(128, Math.min(4096, +e.target.value || 128)) })}/></Field></div>}
              <Field label="场景描述 / 正向提示词"><textarea rows="7" value={p.prompt} maxLength="8000" onChange={(e) => engine.patch({ prompt: e.target.value })}/></Field>
              <Button onClick={() => engine.patch({ prompt: `${ISO_PROMPT}\n${p.prompt === ISO_PROMPT ? '' : p.prompt}`.trim() })}>＋ 45° 等距视角预设</Button>
              <p className="mx-hint">等距只限定视角；地图生成内容会要求铺满矩形画幅的四边和四角。</p>
              <Field label="反向提示词"><textarea rows="3" value={p.negativePrompt} onChange={(e) => engine.patch({ negativePrompt: e.target.value })}/></Field>
              {p.tiles.length <= 1 && <ReferenceControls project={p} engine={engine} config={config} notify={notify} onUpload={() => styleRef.current.click()}/>}
            </fieldset>
            <ReferenceSummary project={p} operation={p.tiles.length ? 'expand' : 'seed'}/>
            <Button disabled={locked} onClick={() => setTab('prompts')}>查看最终提示词 / 请求记录</Button>
            <Button primary disabled={locked || (p.tiles.length ? !tile || occupied : !p.prompt.trim())} onClick={() => p.tiles.length ? engine.expand(dir) : engine.seed()}>{occupied ? '目标位置已有图块' : p.tiles.length ? matchingWork && p.work.status === 'paused' ? '继续生成剩余分段' : `生成${dir.label}相邻地图块` : '✦ 生成初始地图'}</Button>
            {p.tiles.length === 1 && (!tile?.kind || tile.kind === 'base') && <Button disabled={locked || !p.prompt.trim()} onClick={engine.seed} title="沿用当前描述、尺寸和风格参考重新生成主图">重新生成主图</Button>}
            <p className="mx-hint">本次最多 {p.tiles.length ? p.subdivisions ** 2 : 1} 次图像请求 · {PROVIDERS[p.provider]}{matchingWork && p.work.completedParts.length ? ` · 已保留 ${p.work.completedParts.length} 个分段` : ''}</p>
            <div className="mx-divider"/><h3>局部重绘</h3><p className="mx-hint">框选选中图块内需要修改的区域，再描述修改内容。</p>
            <Button disabled={locked || !tile} primary={tool === 'retouch'} onClick={() => { setTool('retouch'); setRetouchPoints([]); }}>框选重绘区域</Button>
            <Field label="修改要求"><textarea value={retouchPrompt} rows="3" disabled={locked} onChange={(e) => setRetouchPrompt(e.target.value)}/></Field><Button disabled={locked || !retouchPoints.length} onClick={() => engine.retouch(retouchPoints, retouchPrompt)}>生成局部重绘预览</Button>
            <button className="mx-danger-link" disabled={locked || !tile} onClick={engine.deleteTile}>删除选中图块</button>
          </>}
          {tab === 'auto' && <><p className="mx-hint">自动任务固定使用启动时的场景、全局规则与比例设置，沿已有地图衔接，不使用初始参考图。实际分段内容在请求记录中查看。</p><Button onClick={() => setTab('prompts')}>查看自动任务请求记录</Button>
            <div className="mx-panel-heading"><small>AUTOMATIC OUTPAINTING</small><h2>自动扩展地图</h2><p>围绕选中图块补全矩形范围，完成一块后继续向外延伸。</p></div>
            <fieldset disabled={locked || !tile} className="mx-fieldset"><div className="mx-two"><Field label="目标列数"><input type="number" min="1" max="9" value={batchWidth} onChange={(e) => setBatchWidth(Math.max(1, Math.min(9, +e.target.value || 1)))}/></Field><Field label="目标行数"><input type="number" min="1" max="9" value={batchHeight} onChange={(e) => setBatchHeight(Math.max(1, Math.min(9, +e.target.value || 1)))}/></Field></div><Field label="同时生成"><select value={concurrency} onChange={(e) => setConcurrency(+e.target.value)}><option value="1">1 块 · 顺序生成</option><option value="2">2 块</option><option value="3">3 块</option></select></Field></fieldset>
            <div className="mx-estimate"><strong>{batch.length}</strong><span>个空位 · 最多 {batch.length * p.subdivisions ** 2} 次图像请求<br/>默认使用当前提示词和图像服务</span></div>
            <Button primary disabled={locked || !batch.length || !tile} onClick={() => engine.startBatch(batchWidth, batchHeight, concurrency)}>开始自动扩图</Button>
            {q && <div className="mx-queue"><h3>本批任务 <span>{done} / {q.tasks.length}</span></h3><progress max={q.tasks.length} value={done}/><div className="mx-inline">{q.status === 'running' && <Button onClick={engine.pauseBatch}>暂停</Button>}{['paused', 'stopped'].includes(q.status) && <Button primary disabled={engine.pumpActive} onClick={engine.resumeBatch}>继续 / 重试失败</Button>}{['running', 'pausing', 'paused'].includes(q.status) && <Button onClick={engine.stopBatch}>停止</Button>}<Button disabled={engine.pumpActive || Boolean(busy)} onClick={engine.undoBatch}>整批撤销</Button></div><p className="mx-hint">暂停会等待正在生成的任务完成。停止会中断等待；已提交给服务的请求仍可能计费。</p><div className="mx-task-list">{q.tasks.map((t) => <div key={t.id} className={`mx-task ${t.status}`}><b>{t.x}, {t.y}</b><span>{({ waiting: '等待', running: '生成中', done: '完成', failed: '失败' })[t.status]}{t.status !== 'done' && t.completedParts.length ? ` · ${t.completedParts.length} 分段` : ''}</span>{t.error && <small>{t.error}</small>}</div>)}</div></div>}
          </>}
          {tab === 'layers' && <>
            <div className="mx-panel-heading"><small>GROUND & OBJECTS</small><h2>地图分层</h2><p>按蒙版从原图提取物件，地面层可单独补全；原图始终保留。</p></div>
            <Button disabled={locked} onClick={() => setTab('prompts')}>查看分层最终提示词 / 请求记录</Button>
            <DirectLayerControls project={p} tile={tile} engine={engine} notify={notify} config={config}
              maskEditing={maskEditing} onMaskEditingChange={(value) => { setMaskEditing(value); if (value) { setView('original'); setPreviewDraft(false); } }}
              maskPaintMode={maskPaintMode} setMaskPaintMode={setMaskPaintMode} maskBrushSize={maskBrushSize} setMaskBrushSize={setMaskBrushSize}
              maskThreshold={maskThreshold} setMaskThreshold={setMaskThreshold} maskFeather={maskFeather} setMaskFeather={setMaskFeather}/>
            {draft && <>
              <div className="mx-segment">{[['objects', '物件'], ['ground', '地面'], ['original', '原图']].map(([id, text]) => <button key={id} className={layerView === id ? 'active' : ''} onClick={() => setLayerView(id)}>{text}</button>)}</div>
              <div className={`mx-layer-preview bg-${layerBg}`}><AssetImg id={layerView === 'original' ? tile.originalId : layerView === 'ground' ? draft.groundId : draft.objectsId} assets={assets} alt="分层预览"/></div>
              <div className="mx-inline"><span className="mx-hint">检查背景</span>{['checker', 'black', 'white'].map((bg) => <button key={bg} className={`mx-bg-dot ${bg} ${layerBg === bg ? 'active' : ''}`} aria-label={`${bg}背景`} onClick={() => setLayerBg(bg)}/>)}</div>
              <label className="mx-check"><input type="checkbox" checked={previewDraft} onChange={(e) => setPreviewDraft(e.target.checked)}/>在画布预览分层结果</label>
              {tile.layerDraft && <><p className="mx-hint">{validLayerPair(draft) ? draft.layerMode === 'mask' ? '物件层预览已就绪；地面可单独补图。检查透明边缘和原图对齐后接纳。' : '两层已就绪，请分别检查轮廓、地面与原图位置后接纳。' : '请生成有效物件层预览后再接纳。'}</p><div className="mx-inline"><Button primary disabled={locked || !validLayerPair(draft)} onClick={engine.acceptLayers}>接纳{draft.layerMode === 'mask' ? '物件层' : '分层'}</Button><Button disabled={locked} onClick={engine.discardLayers}>丢弃预览</Button></div></>}
            </>}
            <p className="mx-hint">分别检查物件轮廓和地面补绘结果。适合角色穿行的建筑仍需单独标记碰撞与遮挡区域。</p>
          </>}
          {tab === 'regions' && <>
            <div className="mx-panel-heading"><small>REGION EDITOR</small><h2>区域标记</h2><p>{regionType === 'collision' ? '碰撞格支持左键拖动涂抹；这里只显示碰撞区数据。' : `当前仅显示${REGION_TYPES[regionType]}的轮廓、列表和属性，可连续绘制多个独立区域。`}</p></div>
            <fieldset disabled={locked || !p.tiles.length} className="mx-fieldset"><Field label="区域类型"><select value={regionType} onChange={(e) => { cancelDrawing(); engine.setSelectedRegionId(''); setRegionType(e.target.value); }}>{Object.entries(REGION_TYPES).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></Field>{regionType !== 'collision' && <><div className="mx-segment">{[['rectangle', '矩形'], ['polygon', '多边形'], ['free', '自由绘制']].map(([v, text]) => <button key={v} className={shape === v ? 'active' : ''} onClick={() => { cancelDrawing(); setShape(v); }}>{text}</button>)}</div><div className="mx-inline"><Button primary={tool === 'draw'} onClick={() => { cancelDrawing(); engine.setSelectedRegionId(''); setTool('draw'); }}>绘制新区域</Button><Button primary={tool === 'select'} onClick={() => { cancelDrawing(); setTool('select'); }}>选择 / 移动</Button></div></>}</fieldset>
            <p className="mx-hint">{collisionEdit ? `按住左键拖动连续标记；从空格开始添加，从已标记格开始擦除。单击仍可切换单格。当前 ${collisionRegion?.cells?.length || 0} 格。右键或空格拖动地图。` : shape === 'polygon' ? '点击起点、Enter、双击或保存按钮完成；保存后可直接画下一块。Backspace 撤回上一点，Esc 取消。' : '在画布上按住左键绘制。'}{!collisionEdit && ' 选中区域后可拖动。'}</p>
            {['collision', 'occlusion'].includes(regionType) && <section className="mx-auto-region-analysis">
              <strong>{regionType === 'collision' ? 'AI 自动识别碰撞格' : 'AI 自动识别遮挡区'}</strong>
              <p className="mx-hint">{regionType === 'collision' ? '识别地图中角色无法通过的地面格。结果先在画布预览，确认后才应用。' : '仅分析已接纳的透明物件层；圈出角色经过其后方时应显示在前景的物件部分。'}</p>
              <Field label="视觉识别模型"><select value={regionAnalysisProvider} disabled={locked || Boolean(regionAnalysisBusy)} onChange={(event) => { setRegionAnalysisProvider(event.target.value); setRegionAnalysis(null); }}>
                {['gemini', 'openai', 'qwen'].map((provider) => <option key={provider} value={provider}>{({ gemini: 'Gemini', openai: 'OpenAI', qwen: '千问' })[provider]} · {config.configured[provider] ? '已配置' : '未配置'}</option>)}
              </select></Field>
              <Button primary disabled={locked || Boolean(regionAnalysisBusy) || !p.tiles.length} onClick={() => analyzeRegions(regionType)}>{regionAnalysisBusy === regionType ? '正在分析地图…' : regionType === 'collision' ? 'AI 分析碰撞格 · 1 次调用' : 'AI 分析遮挡区 · 1 次调用'}</Button>
              {regionType === 'occlusion' && <p className="mx-hint">识别前需先在“分层”接纳所有地图块的透明物件层；不会向 AI 发送原始底图或地面图。</p>}
              {regionAnalysis?.sourceKey === regionAnalysisSourceKey && regionAnalysis.error && <p className="mx-analysis-error" role="alert">{regionAnalysis.error}</p>}
              {regionAnalysis && regionAnalysis.sourceKey !== regionAnalysisSourceKey && <p className="mx-analysis-error" role="status">地图、网格或图层已变化，这份预览已过期。请重新分析。</p>}
              {currentRegionAnalysis?.kind === 'collision' && <div className="mx-analysis-preview">
                <b>预览：{currentRegionAnalysis.cells.length} 个碰撞格{currentRegionAnalysis.uncertain.length ? ` · ${currentRegionAnalysis.uncertain.length} 个待人工确认` : ''}</b>
                {!currentRegionAnalysis.cells.length && <p className="mx-hint">没有识别到明确碰撞格。可调整地图或网格后重新分析。</p>}
                {!!currentRegionAnalysis.cells.length && <p className="mx-hint">黄色格为 AI 建议，红色格是已有标记。默认合并可保留手绘标记；替换会覆盖已有碰撞格。</p>}
                {!!currentRegionAnalysis.cells.length && <div className="mx-inline"><Button primary disabled={locked} onClick={() => applyCollisionAnalysis(false)}>合并并应用</Button><Button disabled={locked} onClick={() => applyCollisionAnalysis(true)}>替换现有标记</Button></div>}
                <Button disabled={locked} onClick={() => setRegionAnalysis(null)}>丢弃预览</Button>
              </div>}
              {currentRegionAnalysis?.kind === 'occlusion' && <div className="mx-analysis-preview">
                <b>预览：{currentRegionAnalysis.regions.length} 个遮挡区{currentRegionAnalysis.uncertain.length ? ` · ${currentRegionAnalysis.uncertain.length} 条不确定说明` : ''}</b>
                {currentRegionAnalysis.regions.length > 0 && <><p className="mx-hint">蓝色轮廓为前景遮挡多边形，黄色线为脚底排序基准。请检查后再应用。</p><ul>{currentRegionAnalysis.regions.slice(0, 8).map((item, index) => <li key={index}>{item.name} · 置信度 {Math.round(item.confidence * 100)}% · {item.reason}</li>)}</ul><Button primary disabled={locked} onClick={applyOcclusionAnalysis}>添加 {currentRegionAnalysis.regions.length} 个遮挡区</Button></>}
                {!currentRegionAnalysis.regions.length && <p className="mx-hint">没有识别到明确遮挡区。</p>}
                <Button disabled={locked} onClick={() => setRegionAnalysis(null)}>丢弃预览</Button>
              </div>}
            </section>}
            {regionType !== 'collision' && <div className="mx-region-actions">
              {localPolygon && <><p className="mx-hint" role="status">当前 {polygonDraft.points.length} 个顶点 · {polygonDraft.active ? '未保存轮廓' : '等待绘制下一块'}</p>
                <div className="mx-inline"><Button primary disabled={locked || polygonDraft.points.length < 3} onClick={finishPolygon}>保存当前区域</Button><Button disabled={locked || !polygonDraft.points.length} onClick={() => editPolygon('undo')}>撤回上一点</Button><Button disabled={locked || !polygonDraft.active} onClick={cancelDrawing}>取消当前绘制</Button></div></>}
              <div className="mx-inline"><Button disabled={!canUndoAction} onClick={undoAction} title="Ctrl / ⌘ Z">撤销操作</Button><Button disabled={!canRedoAction} onClick={redoAction} title="Ctrl / ⌘ Shift Z">重做操作</Button></div>
              <p className="mx-hint">保存当前区域后会自动保存草稿；顶部“保存”用于保存整个项目。</p>
            </div>}
            <h3>{REGION_TYPES[regionType]}列表 · {currentTypeRegions.length} 个区域</h3>
            {region && <fieldset className="mx-region-details mx-fieldset" disabled={locked}><Field label="区域名称"><input value={region.name} onChange={(e) => engine.updateRegion(region.id, { name: e.target.value })}/></Field>{region.type === 'collision' && <p className="mx-hint">已标记 {region.cells?.length || 0} 个碰撞格；从空格开始拖动添加，从已标记格开始拖动擦除。</p>}{['occlusion', 'top'].includes(region.type) && <Field label="脚底排序基准 Y（地图像素）"><input type="number" value={Math.round(region.baseline)} onChange={(e) => engine.updateRegion(region.id, { baseline: +e.target.value })}/></Field>}{['occlusion', 'adjustment'].includes(region.type) && <Field label="排序偏移（正值靠前）"><input type="number" value={region.sortOffset} onChange={(e) => engine.updateRegion(region.id, { sortOffset: Math.max(-10000, Math.min(10000, Math.round(+e.target.value))) })}/></Field>}<Button onClick={engine.deleteRegion}>{region.type === 'collision' ? '清除全部碰撞格' : '删除区域'}</Button></fieldset>}
            {!currentTypeRegions.length && <p className="mx-hint">尚未标记{REGION_TYPES[regionType]}。</p>}
            <div className="mx-region-list">{currentTypeRegions.map((r) => <div key={r.id} className={r.id === region?.id ? 'selected' : ''}><button onClick={() => { cancelDrawing(); engine.setSelectedRegionId(r.id); setRegionType(r.type); setTool('select'); }}><i style={{ background: REGION_COLORS[r.type] }}/><span>{r.name}<small>{REGION_TYPES[r.type]}{r.type === 'collision' ? ` · ${r.cells?.length || 0} 格` : ''}</small></span></button>{r.type !== 'collision' && <button aria-label={`切换${r.name}显隐`} disabled={locked} onClick={() => engine.updateRegion(r.id, { visible: r.visible === false })}>{r.visible === false ? '○' : '◉'}</button>}</div>)}</div>
          </>}
          {tab === 'export' && <>
            <div className="mx-panel-heading"><small>EXPORT ASSETS</small><h2>导出地图资源</h2><p>图片、图层和区域使用同一套地图像素坐标。</p></div>
            <div className="mx-export-list">{[['png', '合成 PNG', '当前可见图层合成一张图片'], ['layers', '分层 / 分块 PNG ZIP', '原图、地面、物件和区域坐标清单'], ['psd', '分层 PSD', '保留地面、物件与遮挡区域图层'], ['project', '可编辑项目 ZIP', '包含素材、生成进度和区域标记'], ['unity', 'Unity 2D 资源包', '图片 + map.json + C# 导入和排序组件']].map(([id, name, text]) => <button key={id} disabled={!p.tiles.length || Boolean(exporting)} onClick={() => doExport(id)}><span className="mx-export-icon">{id === 'unity' ? 'U' : id === 'psd' ? 'Ps' : '↓'}</span><span><strong>{exporting === id ? '正在导出…' : name}</strong><small>{text}</small></span><b>↗</b></button>)}</div>
            <p className="mx-hint">碰撞格导出到 map.json 的 collisionGrid.cells，使用从 0 开始的 row / col；等距网格按底尖 (0,0) 编号。</p>
            <Field label="Unity Pixels Per Unit"><input type="number" min="1" max="10000" value={p.pixelsPerUnit} disabled={locked} onChange={(e) => engine.patch({ pixelsPerUnit: Math.max(1, Math.min(10000, +e.target.value || 100)) })}/></Field>
            <p className="mx-hint">Unity 包适用于 2022.3 / 团结，使用 SpriteRenderer、PolygonCollider2D 和脚底 Y 排序。解压后按说明导入，会生成地图 Prefab。</p>
            <div className="mx-divider"/><Button disabled={locked} onClick={() => zipRef.current.click()}>打开项目 ZIP</Button><p className="mx-hint">大地图可使用分块 ZIP 导出，避免整图合成超出浏览器内存。</p>
          </>}
        </div>
      </aside>
    </div>
    <input ref={styleRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { if (e.target.files[0]) engine.importStyle(e.target.files[0]); e.target.value = ''; }}/>
    <input ref={zipRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => { if (e.target.files[0]) engine.importZip(e.target.files[0]); e.target.value = ''; }}/>
    {projects !== null && <div className="mx-dialog-shade"><section className="mx-project-dialog" role="dialog" aria-modal="true" aria-label="打开地图项目"><header><h2>打开本地地图</h2><Button onClick={() => setProjects(null)}>关闭</Button></header><Button onClick={() => { setProjects(null); zipRef.current.click(); }}>导入项目 ZIP</Button>{projects.length ? projects.map((saved) => <button className="mx-saved-project" key={saved.id} onClick={async () => { await engine.load(saved); setProjects(null); setTimeout(fit, 50); }}><strong>{saved.name}</strong><span>{saved.tiles?.length || 0} 块 · {saved.schemaVersion === 2 ? '新版项目' : '旧版 · 打开为升级副本'}</span><small>{new Date(saved.savedAt || 0).toLocaleString('zh-CN')}</small></button>) : <p>还没有保存的地图项目。</p>}</section></div>}
  </div>;
}
