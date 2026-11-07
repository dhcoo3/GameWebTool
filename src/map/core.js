import { normalizeReferenceSettings } from './reference.js';
import { gridCellPolygon, gridMetrics, normalizeGrid } from '../gridGeometry.js';
import { normalizeScaleReference, newScaleReference } from './scale.js';
import { GEMINI_GROUND_RESOLUTIONS } from './geminiResolution.js';

export const FORMAT = 'game-asset-factory-map';
export const DRAFT_ID = '__map_draft_v2__';
export const PROVIDERS = { gemini: 'Google Gemini', openai: 'OpenAI', apiyi: 'API易', qwen: '千问', kling: '可灵' };
export const DIRECTIONS = [
  ['nw', '西北', -1, -1, '↖'], ['n', '北', 0, -1, '↑'], ['ne', '东北', 1, -1, '↗'],
  ['w', '西', -1, 0, '←'], ['e', '东', 1, 0, '→'],
  ['sw', '西南', -1, 1, '↙'], ['s', '南', 0, 1, '↓'], ['se', '东南', 1, 1, '↘'],
].map(([id, label, dx, dy, arrow]) => ({ id, label, dx, dy, arrow }));
export const REGION_TYPES = { collision: '碰撞区', occlusion: '遮挡区', adjustment: '排序调节区', top: '最上层' };
export const REGION_COLORS = { collision: '#e27460', occlusion: '#6c9bce', adjustment: '#b28ad0', top: '#d2ad49' };
export const ISO_PROMPT = '45°等距斜视游戏场景，正交投影，所有建筑保持一致朝向和比例。细腻像素风，清晰纹理，统一光照和配色。地形铺满整个矩形画面，包括四个角，像从连续世界中截取的一块区域，便于向四周扩图。等距仅描述视角，地图外轮廓保持矩形；不生成菱形展示地块、悬浮岛、底座、切面或黑色留边。没有天空、远景雾化、文字、边框或人物。';
export const uid = () => globalThis.crypto?.randomUUID?.() || `map-${Date.now()}-${Math.random().toString(16).slice(2)}`;
export const keyOf = (x, y) => `${x},${y}`;
export const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
export function newProject() {
  return {
    format: FORMAT, schemaVersion: 2, id: null, name: '未命名地图', tiles: [], regions: [],
    tileWidth: 1024, tileHeight: 1024, overlapX: 15, overlapY: 15,
    prompt: ISO_PROMPT, negativePrompt: '文字，水印，边框，网格线，不一致的透视，重复地标，菱形地图外轮廓，悬浮地块，展示底座，黑色留边，四角空白',
    globalPositivePrompt: '', globalNegativePrompt: '',
    stitchFeather: 8, expansionPolicy: 'legacy', expansionReferenceVersion: 1, expansionContext: 'standard', expansionContextEnabled: false, expansionDescription: '', expansionStrategy: 8, provider: 'gemini', resolution: 'native', groundResolution: 'auto', subdivisions: 1, styleAssetId: '', referenceSettings: normalizeReferenceSettings(), requestLog: null,
    visibility: { ground: true, objects: true }, pixelsPerUnit: 100, grid: normalizeGrid(), scaleReference: newScaleReference(), queue: null, layerQueue: null, work: null,
  };
}
export function steps(p) {
  return { x: p.tileWidth - Math.round(p.tileWidth * p.overlapX / 100), y: p.tileHeight - Math.round(p.tileHeight * p.overlapY / 100) };
}
export function tileRect(p, tile) {
  const step = steps(p);
  return { x: tile.px ?? tile.x * step.x, y: tile.py ?? tile.y * step.y, width: tile.width || p.tileWidth, height: tile.height || p.tileHeight };
}
export function mapBounds(p, extra = []) {
  const list = [...p.tiles, ...extra].map((t) => tileRect(p, t));
  if (!list.length) return { x: 0, y: 0, width: p.tileWidth, height: p.tileHeight };
  const x = Math.min(...list.map((r) => r.x)), y = Math.min(...list.map((r) => r.y));
  return { x, y, width: Math.max(...list.map((r) => r.x + r.width)) - x, height: Math.max(...list.map((r) => r.y + r.height)) - y };
}
export function mapGridGeometry(p) {
  const grid = normalizeGrid(p.grid), metrics = gridMetrics(grid, grid.cellWidthPx);
  const main = p.tiles.find((tile) => tile.kind === 'base') || p.tiles.find((tile) => tile.x === 0 && tile.y === 0);
  const reference = main ? tileRect(p, main) : { x: 0, y: 0, width: p.tileWidth, height: p.tileHeight };
  const center = { x: reference.x + reference.width / 2, y: reference.y + reference.height / 2 };
  return { x: center.x - metrics.boardWidth / 2, y: center.y - metrics.boardHeight / 2, width: metrics.boardWidth, height: metrics.boardHeight, center, metrics };
}
export function mapGridCellPolygon(p, column, row) {
  const grid = normalizeGrid(p.grid), metrics = gridMetrics(grid, grid.cellWidthPx), geometry = mapGridGeometry(p);
  return gridCellPolygon(grid, metrics, column, row).map((point) => ({ x: geometry.x + point.x, y: geometry.y + point.y }));
}
export function collisionCellAddress(gridValue, column, row) {
  const grid = normalizeGrid(gridValue);
  if (grid.layout === 'isometric' || grid.layout === 'isometricZAsY') return { row: grid.height - 1 - row, col: grid.width - 1 - column };
  return { row, col: column };
}
// Labels use the same (row, col) addresses as the Unity collision-grid export.
export function gridCoordinateLabels(gridValue) {
  const grid = normalizeGrid(gridValue), metrics = gridMetrics(grid, grid.cellWidthPx), labels = [];
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    const points = gridCellPolygon(grid, metrics, x, y), address = collisionCellAddress(grid, x, y);
    labels.push({ key: `${x},${y}`, x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length, ...address });
  }
  return labels;
}
export function collisionCellIndex(gridValue, row, col) {
  const grid = normalizeGrid(gridValue);
  if (grid.layout === 'isometric' || grid.layout === 'isometricZAsY') return { x: grid.width - 1 - col, y: grid.height - 1 - row };
  return { x: col, y: row };
}
function polygonContainsCell(project, points, x, y) {
  const polygon = mapGridCellPolygon(project, x, y), center = polygon.reduce((sum, point) => ({ x: sum.x + point.x / polygon.length, y: sum.y + point.y / polygon.length }), { x: 0, y: 0 });
  if (pointInPolygon(center, points) || polygon.some((point) => pointInPolygon(point, points))) return true;
  if (points.some((point) => pointInPolygon(point, polygon))) return true;
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSegment = (a, b, p) => Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
  const crosses = (a, b, c, d) => {
    const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
    return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d)) || (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b)) || (abC < 0) !== (abD < 0) && (cdA < 0) !== (cdB < 0);
  };
  return points.some((point, index) => polygon.some((corner, side) => crosses(point, points[(index + 1) % points.length], corner, polygon[(side + 1) % polygon.length])));
}
function normalizeCollisionRegions(project, savedRegions) {
  const regions = [], cells = new Map();
  for (const region of savedRegions || []) {
    if (region.type !== 'collision') { regions.push({ ...region, visible: region.visible !== false, sortOffset: Number(region.sortOffset) || 0 }); continue; }
    for (const cell of region.cells || []) {
      const x = Number(cell.x), y = Number(cell.y);
      if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < project.grid.width && y < project.grid.height) cells.set(`${x},${y}`, { x, y });
    }
    if ((!region.cells || !region.cells.length) && Array.isArray(region.points) && region.points.length >= 3) {
      for (let y = 0; y < project.grid.height; y++) for (let x = 0; x < project.grid.width; x++) {
        if (polygonContainsCell(project, region.points, x, y)) cells.set(`${x},${y}`, { x, y });
      }
    }
  }
  if (cells.size) regions.push({ id: 'grid-collision', type: 'collision', name: '碰撞格子', cells: [...cells.values()], visible: true, sortOffset: 0 });
  return regions;
}
export function collisionRegionsForPhysics(project) {
  return [
    ...project.regions.filter((region) => region.type !== 'collision'),
    ...project.regions.filter((region) => region.type === 'collision').flatMap((region) => (region.cells || []).map((cell) => ({ ...region, points: mapGridCellPolygon(project, cell.x, cell.y) }))),
  ];
}
export function mapWorkspaceBounds(p) {
  const bounds = mapBounds(p);
  if (!normalizeGrid(p.grid).visible) return bounds;
  const grid = mapGridGeometry(p), x = Math.min(bounds.x, grid.x), y = Math.min(bounds.y, grid.y);
  return { x, y, width: Math.max(bounds.x + bounds.width, grid.x + grid.width) - x, height: Math.max(bounds.y + bounds.height, grid.y + grid.height) - y };
}
export function reflow(p, overlapX, overlapY) {
  const next = { ...p, overlapX: clamp(overlapX, 0, 40), overlapY: clamp(overlapY, 0, 40) };
  const step = steps(next);
  const translatePoint = (point) => {
    if (!p.tiles.length) return point;
    const containing = p.tiles.find((t) => { const r = tileRect(p, t); return point.x >= r.x && point.y >= r.y && point.x <= r.x + r.width && point.y <= r.y + r.height; });
    const owner = containing || p.tiles.reduce((best, t) => { const distance = (tile) => { const r = tileRect(p, tile); return Math.hypot(point.x - r.x - r.width / 2, point.y - r.y - r.height / 2); }; return distance(t) < distance(best) ? t : best; });
    const old = tileRect(p, owner);
    return { x: point.x + owner.x * step.x - old.x, y: point.y + owner.y * step.y - old.y };
  };
  return { ...next, tiles: p.tiles.map((t) => ({ ...t, px: t.x * step.x, py: t.y * step.y })), regions: p.regions.map((r) => {
    if (r.type === 'collision') return r;
    const baselineAnchor = { x: r.points.reduce((n, v) => n + v.x, 0) / r.points.length, y: r.baseline };
    return { ...r, points: r.points.map(translatePoint), baseline: translatePoint(baselineAnchor).y };
  }) };
}
export function intersection(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
export function polygonBounds(points) {
  const x = Math.floor(Math.min(...points.map((p) => p.x))), y = Math.floor(Math.min(...points.map((p) => p.y)));
  return { x, y, width: Math.max(1, Math.ceil(Math.max(...points.map((p) => p.x))) - x), height: Math.max(1, Math.ceil(Math.max(...points.map((p) => p.y))) - y) };
}
export function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function batchTargets(p, center, width, height) {
  const w = Math.round(clamp(width, 1, 9)), h = Math.round(clamp(height, 1, 9));
  const occupied = new Set(p.tiles.map((t) => keyOf(t.x, t.y)));
  const list = [];
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const x = center.x + col - Math.floor((w - 1) / 2), y = center.y + row - Math.floor((h - 1) / 2);
    if (!occupied.has(keyOf(x, y))) list.push({ id: uid(), x, y, status: 'waiting', completedParts: [], error: '' });
  }
  return list.sort((a, b) => Math.abs(a.x - center.x) + Math.abs(a.y - center.y) - Math.abs(b.x - center.x) - Math.abs(b.y - center.y) || a.y - b.y || a.x - b.x);
}
export function readyTasks(p, tasks) {
  const active = tasks.filter((t) => t.status === 'running');
  const chosen = [];
  for (const task of tasks) {
    if (task.status !== 'waiting' || !p.tiles.some((t) => Math.abs(t.x - task.x) <= 1 && Math.abs(t.y - task.y) <= 1)) continue;
    if ([...active, ...chosen].some((t) => Math.abs(t.x - task.x) <= 1 && Math.abs(t.y - task.y) <= 1)) continue;
    chosen.push(task);
  }
  return chosen;
}
export function splitRect(width, height, divisions) {
  const n = [1, 2, 3].includes(Number(divisions)) ? Number(divisions) : 1;
  const list = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const left = Math.round(x * width / n), top = Math.round(y * height / n);
    list.push({ x: left, y: top, width: Math.round((x + 1) * width / n) - left, height: Math.round((y + 1) * height / n) - top });
  }
  return list;
}
export function normalizeProject(saved) {
  const p = { ...newProject(), ...saved, schemaVersion: 2, format: FORMAT };
  p.expansionPolicy = 'legacy';
  // Keep unfinished work as project data without resuming a retired strategy.
  if (p.work?.expansionPolicy === 'spatial-template-v2') {
    p.retiredExpansionWork = p.work;
    p.work = null;
  }
  const legacyReference = saved.expansionReferenceVersion !== 1 || Boolean(saved.expansionMode);
  const oldDescription = typeof saved.expansionDescription === 'string' ? saved.expansionDescription.slice(0, 8000) : '';
  // Descriptions were inactive in context mode; retain them without silently changing old requests.
  p.expansionDescription = legacyReference && saved.expansionMode !== 'single' ? '' : oldDescription;
  if (legacyReference && saved.expansionMode !== 'single' && oldDescription) p.retiredExpansionDescription = oldDescription;
  if (legacyReference && p.work) {
    p.retiredExpansionWorks = [...(p.retiredExpansionWorks || []), p.work];
    p.work = null;
  }
  delete p.expansionMode;
  p.expansionReferenceVersion = 1;
  p.expansionContext = 'standard';
  p.expansionContextEnabled = saved.expansionContextEnabled === true;
  p.expansionStrategy = 8;
  p.stitchFeather = Number.isFinite(Number(saved.stitchFeather ?? 8)) ? Math.max(0,Math.min(32,Math.round(Number(saved.stitchFeather ?? 8)))) : 8;
  p.visibility = { ...newProject().visibility, ...saved.visibility };
  for (const key of ['globalPositivePrompt', 'globalNegativePrompt']) p[key] = typeof saved[key] === 'string' ? saved[key] : '';
  p.referenceSettings = normalizeReferenceSettings(saved.referenceSettings);
  p.grid = normalizeGrid(saved.grid);
  p.scaleReference = normalizeScaleReference(saved.scaleReference);
  p.groundResolution = GEMINI_GROUND_RESOLUTIONS.includes(saved.groundResolution) ? saved.groundResolution : 'auto';
  p.regions = normalizeCollisionRegions(p, saved.regions || []);
  if (p.queue) p.queue = { ...p.queue, status: ['running', 'pausing'].includes(p.queue.status) ? 'paused' : p.queue.status, tasks: p.queue.tasks.map((t) => ({ ...t, status: t.status === 'running' ? 'waiting' : t.status })) };
  if (legacyReference && p.queue?.settings) {
    const { expansionMode, ...settings } = p.queue.settings;
    const wasSingle = (expansionMode ?? saved.expansionMode) === 'single';
    if (!wasSingle && settings.expansionDescription) {
      settings.retiredExpansionDescription = settings.expansionDescription;
      settings.expansionDescription = '';
    }
    p.queue = { ...p.queue, settings, ...(wasSingle && !p.queue.retired && p.queue.status !== 'complete' ? {
      status: p.queue.status === 'stopped' ? 'stopped' : 'paused',
      tasks: p.queue.tasks.map((t) => ['done', 'review'].includes(t.status) ? t : { ...t, status: 'waiting', previousParts: [...(t.previousParts || []), ...(t.completedParts || [])], completedParts: [], error: '' }),
    } : {}) };
  }
  if (p.queue?.settings?.expansionPolicy === 'spatial-template-v2') p.queue = { ...p.queue, retired: true, status: p.queue.status === 'complete' ? 'complete' : 'stopped' };
  if (p.queue && !p.queue.retired && p.queue.settings?.expansionStrategy !== 8) p.queue = { ...p.queue, status: p.queue.status === 'complete' ? 'complete' : 'paused', settings: { ...p.queue.settings, expansionContext: p.expansionContext, expansionContextEnabled: p.expansionContextEnabled, expansionStrategy: 8 }, tasks: p.queue.tasks.map((t) => ['done', 'review'].includes(t.status) ? t : { ...t, status: 'waiting', previousParts: [...(t.previousParts || []), ...(t.completedParts || [])], completedParts: [], error: '' }) };
  if (p.layerQueue) p.layerQueue = { ...p.layerQueue, status: p.layerQueue.status === 'running' || p.layerQueue.status === 'pausing' ? 'paused' : p.layerQueue.status,
    tasks: p.layerQueue.tasks.map((t) => ({ ...t, status: t.status === 'running' ? 'waiting' : t.status })) };
  if (p.work?.status === 'running') p.work = { ...p.work, status: 'paused' };
  return p;
}
export function collectAssetIds(p) {
  const ids = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, value] of Object.entries(v)) {
      if ((k.endsWith('AssetId') || ['assetId', 'originalId', 'groundId', 'objectsId', 'maskId', 'rawMaskId'].includes(k)) && typeof value === 'string' && value) ids.add(value);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(p); return [...ids];
}
export function assetFor(tile, layer) {
  if (layer === 'ground') return tile.groundId || tile.originalId;
  if (layer === 'objects') return tile.objectsId || '';
  return tile.originalId;
}
