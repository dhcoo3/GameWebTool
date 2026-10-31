import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GRID_LAYOUTS as LAYOUTS, gridMetrics as metricsFor, gridCellPolygon as cellPolygon } from './gridGeometry.js';

const DB_NAME = 'scene-generation-local';
const STORE_NAME = 'projects';
const DRAFT_ID = '__scene_draft__';
const TOOLS = [
  { id: 'brush', label: '画笔选区', icon: 'brush' },
  { id: 'rectangle', label: '矩形选区', icon: 'rect' },
  { id: 'collisionPaint', label: '标记碰撞', icon: 'collision' },
  { id: 'collisionErase', label: '擦除碰撞', icon: 'erase' },
];

const ICONS = {
  brush: <><path d="m14 6 4 4M3 21c4 0 7-2 7-6l8-8a2.8 2.8 0 0 0-4-4l-8 8c0 4-3 7-3 10Z"/><path d="M6 18h.01"/></>,
  rect: <><rect x="4" y="5" width="16" height="14" rx="1"/><path d="M8 5v14m8-14v14M4 10h16m-16 5h16"/></>,
  collision: <><path d="m12 3 9 16H3z"/><path d="M12 9v4m0 3h.01"/></>,
  erase: <><path d="m7 21-4-4a2 2 0 0 1 0-3L13 4a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3L11 21z"/><path d="m8 11 6 6m-2 4h9"/></>,
  folder: <><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/></>,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  trash: <><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></>,
  spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></>,
  upload: <><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M20 16v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3"/></>,
  zip: <><path d="M4 3h12l4 4v14H4z"/><path d="M9 3v3h4V3m-2 3v2m0 2v2m0 2v2m0 2v2"/></>,
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
  eyeOff: <><path d="m3 3 18 18M10.6 6.2A10.5 10.5 0 0 1 12 6c6.5 0 10 6 10 6a16 16 0 0 1-3.1 3.5M6.2 6.2C3.5 7.8 2 12 2 12s3.5 6 10 6c1.1 0 2.1-.2 3-.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></>,
};

function Icon({ name, size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}

function uid() { return globalThis.crypto?.randomUUID?.() || `region-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function cellKey(x, y) { return `${x},${y}`; }

function openSceneDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withSceneStore(mode, action) {
  const db = await openSceneDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => { db.close(); resolve(request?.result); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
    transaction.onabort = () => { db.close(); reject(transaction.error); };
  });
}

const scenePut = (project) => withSceneStore('readwrite', (store) => store.put(project));
const sceneGet = (id) => withSceneStore('readonly', (store) => store.get(id));
const sceneList = () => withSceneStore('readonly', (store) => store.getAll());
const sceneDelete = (id) => withSceneStore('readwrite', (store) => store.delete(id));

function makeNewProject() {
  const visibleLayers = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index, true]));
  return {
    schemaVersion: 2,
    id: null,
    name: '未命名场景',
    globalDescription: '',
    globalPositivePrompt: '',
    globalNegativePrompt: '',
    width: 32,
    height: 32,
    cellWidthPx: 100,
    cellHeightPx: 100,
    layout: 'rectangle',
    hexOrientation: 'pointy',
    showGrid: true,
    regions: [],
    collisionCells: [],
    selectionCells: [],
    activeRegionId: null,
    selectedLayer: 0,
    visibleLayers,
    tool: 'brush',
    promptProvider: 'gemini',
    imageProvider: 'gemini',
  };
}

function validCell(cell, width, height) {
  const x = Math.floor(Number(cell?.x));
  const y = Math.floor(Number(cell?.y));
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < width && y < height ? { x, y } : null;
}

function migrateProject(saved) {
  if (saved?.schemaVersion >= 2 && Array.isArray(saved.regions)) {
    const defaults = makeNewProject();
    const width = Math.max(4, Math.min(64, Number(saved.width) || defaults.width));
    const height = Math.max(4, Math.min(64, Number(saved.height) || defaults.height));
    return {
      ...defaults,
      ...saved,
      schemaVersion: 2,
      globalDescription: String(saved.globalDescription || ''),
      globalPositivePrompt: String(saved.globalPositivePrompt || ''),
      globalNegativePrompt: String(saved.globalNegativePrompt || ''),
      showGrid: saved.showGrid !== false,
      width,
      height,
      cellWidthPx: Math.max(1, Math.min(4096, Number(saved.cellWidthPx) || 100)),
      cellHeightPx: Math.max(1, Math.min(4096, Number(saved.cellHeightPx) || 100)),
      regions: saved.regions.map((region, index) => ({
        id: region.id || uid(),
        name: region.name || `区域 ${String(index + 1).padStart(2, '0')}`,
        layer: Math.max(0, Math.min(9, Number(region.layer) || 0)),
        cells: (region.cells || []).map((cell) => validCell(cell, width, height)).filter(Boolean),
        image: region.image || '',
        legacyImageAssetId: region.legacyImageAssetId || '',
        prompt: region.prompt || '',
        negativePrompt: region.negativePrompt || '',
        description: region.description || '',
        referenceImage: region.referenceImage || '',
        referenceName: region.referenceName || '',
        referenceSource: region.referenceSource || (region.referenceImage ? 'manual' : Number(region.layer) > 0 ? 'lower-layers' : 'none'),
        provider: region.provider || saved.imageProvider || 'gemini',
        model: region.model || '',
        createdAt: region.createdAt || Date.now(),
        updatedAt: region.updatedAt || Date.now(),
        legacyOverlap: Boolean(region.legacyOverlap),
      })),
      collisionCells: [...new Map((saved.collisionCells || []).map((cell) => validCell(cell, width, height)).filter(Boolean).map((cell) => [cellKey(cell.x, cell.y), cell])).values()],
      selectionCells: (saved.selectionCells || []).map((cell) => validCell(cell, width, height)).filter(Boolean),
      activeRegionId: saved.activeRegionId || null,
      selectedLayer: Math.max(0, Math.min(9, Number(saved.selectedLayer) || 0)),
      visibleLayers: { ...defaults.visibleLayers, ...(saved.visibleLayers || {}) },
      tool: ['brush', 'rectangle', 'collisionPaint', 'collisionErase'].includes(saved.tool) ? saved.tool : 'brush',
    };
  }

  const defaults = makeNewProject();
  const width = Math.max(4, Math.min(64, Number(saved?.width) || defaults.width));
  const height = Math.max(4, Math.min(64, Number(saved?.height) || defaults.height));
  const assets = Array.isArray(saved?.assets) ? saved.assets : [];
  const regions = [];
  const collisionCells = new Map();
  for (const placement of saved?.placements || []) {
    const asset = assets.find((item) => item.id === placement.assetId);
    if (!asset) continue;
    const x0 = Math.floor(Number(placement.x) || 0);
    const y0 = Math.floor(Number(placement.y) || 0);
    const x1 = Math.ceil((Number(placement.x) || 0) + (Number(asset.unitWidth) || 1));
    const y1 = Math.ceil((Number(placement.y) || 0) + (Number(asset.unitHeight) || 1));
    const cells = [];
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const cell = validCell({ x, y }, width, height);
      if (!cell) continue;
      cells.push(cell);
      if (asset.collision) collisionCells.set(cellKey(x, y), cell);
    }
    if (!cells.length) continue;
    regions.push({
      id: uid(),
      name: asset.name || `迁移区域 ${regions.length + 1}`,
      layer: Math.max(0, Math.min(9, Number(asset.layer) || 0)),
      cells,
      image: '',
      legacyImageAssetId: asset.id,
      prompt: asset.prompt || '',
      negativePrompt: asset.negativePrompt || '',
      description: `由旧项目中的「${asset.category || '绘制单位'}」自动迁移。`,
      referenceImage: '',
      referenceName: '',
      provider: saved.imageProvider || 'gemini',
      model: asset.model || '',
      createdAt: asset.createdAt || Date.now(),
      updatedAt: Date.now(),
      legacyOverlap: false,
    });
  }
  const occupancy = new Set();
  regions.forEach((region) => {
    let hasOverlap = false;
    region.cells.forEach((cell) => {
      const key = `${region.layer}:${cellKey(cell.x, cell.y)}`;
      if (occupancy.has(key)) hasOverlap = true;
      else occupancy.add(key);
    });
    region.legacyOverlap = hasOverlap;
  });
  const migrated = {
    ...defaults,
    ...Object.fromEntries(Object.entries(saved || {}).filter(([key]) => !['assets', 'placements', 'activeAssetId', 'draft'].includes(key))),
    schemaVersion: 2,
    globalDescription: String(saved?.globalDescription || ''),
    globalPositivePrompt: String(saved?.globalPositivePrompt || ''),
    globalNegativePrompt: String(saved?.globalNegativePrompt || ''),
    showGrid: saved?.showGrid !== false,
    width,
    height,
    cellWidthPx: Math.max(1, Math.min(4096, Number(saved?.cellWidthPx) || 100)),
    cellHeightPx: Math.max(1, Math.min(4096, Number(saved?.cellHeightPx) || 100)),
    regions,
    collisionCells: [...collisionCells.values()],
    selectionCells: [],
    activeRegionId: regions[0]?.id || null,
    selectedLayer: 0,
    visibleLayers: defaults.visibleLayers,
    tool: 'brush',
    legacyBackup: { migratedAt: Date.now(), project: saved },
  };
  return migrated;
}

function regionImage(project, region) {
  if (region?.image) return region.image;
  if (!region?.legacyImageAssetId) return '';
  return project.legacyBackup?.project?.assets?.find((asset) => asset.id === region.legacyImageAssetId)?.image || '';
}

function regionReferenceSource(region) {
  return region?.referenceSource || (region?.referenceImage ? 'manual' : Number(region?.layer) > 0 ? 'lower-layers' : 'none');
}

function availableLowerReferenceLayers(project, layer) {
  return [...new Set(project.regions
    .filter((region) => region.layer < layer && project.visibleLayers[region.layer] !== false && regionImage(project, region))
    .map((region) => region.layer))].sort((a, b) => a - b);
}


function polygonBox(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs); const top = Math.min(...ys);
  return { left, top, width: Math.max(1, Math.max(...xs) - left), height: Math.max(1, Math.max(...ys) - top) };
}

function regionGeometry(project, metrics, cells) {
  const polygons = cells.map(({ x, y }) => cellPolygon(project, metrics, x, y));
  if (!polygons.length) return null;
  const bounds = polygonBox(polygons.flat());
  return { ...bounds, polygons: polygons.map((poly) => poly.map((point) => ({ x: point.x - bounds.left, y: point.y - bounds.top }))) };
}

function cellStyle(project, metrics, cell) {
  const points = cellPolygon(project, metrics, cell.x, cell.y);
  const bounds = polygonBox(points);
  const clip = points.map((point) => `${((point.x - bounds.left) / bounds.width) * 100}% ${((point.y - bounds.top) / bounds.height) * 100}%`).join(',');
  return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, clipPath: `polygon(${clip})` };
}

function dataUrlParts(value) {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(value || '');
  return match ? { mimeType: match[1], imageBase64: match[2] } : { mimeType: 'image/png', imageBase64: '' };
}

async function normalizeImageFile(file) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('场景图片读取失败。'));
    image.src = src;
  });
}

function canvasDataUrl(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法编码 PNG。')), 'image/png'));
}

async function renderLayerPng(project, layer) {
  const metrics = metricsFor(project, project.cellWidthPx);
  const width = Math.max(1, Math.ceil(metrics.boardWidth));
  const height = Math.max(1, Math.ceil(metrics.boardHeight));
  if (width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error(`第 ${layer} 层图像过大，请缩小画布或 Cell 像素尺寸后再导出。`);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  const regions = project.regions.filter((region) => region.layer === layer && regionImage(project, region)).sort((a, b) => a.createdAt - b.createdAt);
  for (const region of regions) {
    const geometry = regionGeometry(project, metrics, region.cells);
    if (!geometry) continue;
    const image = await loadImage(regionImage(project, region));
    context.save();
    context.beginPath();
    geometry.polygons.forEach((polygon) => {
      context.moveTo(geometry.left + polygon[0].x, geometry.top + polygon[0].y);
      polygon.slice(1).forEach((point) => context.lineTo(geometry.left + point.x, geometry.top + point.y));
      context.closePath();
    });
    context.clip();
    context.drawImage(image, geometry.left, geometry.top, geometry.width, geometry.height);
    context.restore();
  }
  return { blob: await canvasDataUrl(canvas), width, height };
}

async function renderLowerLayersRegionReference(project, targetRegion, width, height, includeGuide = false) {
  const metrics = metricsFor(project, project.cellWidthPx);
  const targetGeometry = regionGeometry(project, metrics, targetRegion.cells);
  if (!targetGeometry) return { image: '', mask: '', layers: [] };
  const layers = availableLowerReferenceLayers(project, targetRegion.layer);
  if (!layers.length) return { image: '', mask: '', layers };

  const maxReferenceSide = 2048;
  const scale = Math.min(1, maxReferenceSide / Math.max(width, height));
  const referenceWidth = Math.max(1, Math.round(width * scale));
  const referenceHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = referenceWidth;
  canvas.height = referenceHeight;
  const context = canvas.getContext('2d');
  context.fillStyle = '#eef1ed';
  context.fillRect(0, 0, referenceWidth, referenceHeight);
  context.save();
  context.scale(referenceWidth / targetGeometry.width, referenceHeight / targetGeometry.height);
  context.translate(-targetGeometry.left, -targetGeometry.top);

  for (const layer of layers) {
    const regions = project.regions
      .filter((region) => region.layer === layer && regionImage(project, region))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const region of regions) {
      const geometry = regionGeometry(project, metrics, region.cells);
      if (!geometry) continue;
      const image = await loadImage(regionImage(project, region));
      context.save();
      context.beginPath();
      region.cells.forEach(({ x, y }) => {
        const polygon = cellPolygon(project, metrics, x, y);
        context.moveTo(polygon[0].x, polygon[0].y);
        polygon.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        context.closePath();
      });
      context.clip();
      context.drawImage(image, geometry.left, geometry.top, geometry.width, geometry.height);
      context.restore();
    }
  }
  context.restore();

  let guideImage = '';
  if (includeGuide) {
    // Kling accepts a reference image, but this integration does not send a
    // machine-readable inpainting mask. Mark the selected cells on a separate
    // guide image so the road path is spatially explicit.
    const guideCanvas = document.createElement('canvas');
    guideCanvas.width = referenceWidth;
    guideCanvas.height = referenceHeight;
    const guideContext = guideCanvas.getContext('2d');
    guideContext.drawImage(canvas, 0, 0);
    guideContext.save();
    const guideScaleX = referenceWidth / targetGeometry.width;
    const guideScaleY = referenceHeight / targetGeometry.height;
    guideContext.scale(guideScaleX, guideScaleY);
    guideContext.lineJoin = 'round';
    guideContext.lineWidth = 2 / Math.max(guideScaleX, guideScaleY);
    targetGeometry.polygons.forEach((polygon) => {
      guideContext.beginPath();
      guideContext.moveTo(polygon[0].x, polygon[0].y);
      polygon.slice(1).forEach((point) => guideContext.lineTo(point.x, point.y));
      guideContext.closePath();
      guideContext.fillStyle = 'rgba(255, 45, 112, 0.58)';
      guideContext.fill();
      guideContext.strokeStyle = 'rgba(255, 255, 255, 0.96)';
      guideContext.stroke();
    });
    guideContext.restore();
    guideImage = guideCanvas.toDataURL('image/png');
  }

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = referenceWidth;
  maskCanvas.height = referenceHeight;
  const maskContext = maskCanvas.getContext('2d');
  maskContext.fillStyle = '#fff';
  maskContext.fillRect(0, 0, referenceWidth, referenceHeight);
  maskContext.save();
  maskContext.scale(referenceWidth / targetGeometry.width, referenceHeight / targetGeometry.height);
  maskContext.globalCompositeOperation = 'destination-out';
  maskContext.beginPath();
  targetGeometry.polygons.forEach((polygon) => {
    maskContext.moveTo(polygon[0].x, polygon[0].y);
    polygon.slice(1).forEach((point) => maskContext.lineTo(point.x, point.y));
    maskContext.closePath();
  });
  maskContext.fill();
  maskContext.restore();

  return {
    image: canvas.toDataURL('image/png'),
    guideImage,
    mask: maskCanvas.toDataURL('image/png'),
    layers,
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const body = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
    const crc = crc32(body);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true); localView.setUint32(14, crc, true); localView.setUint32(18, body.length, true); localView.setUint32(22, body.length, true);
    localView.setUint16(26, name.length, true); local.set(name, 30);
    localChunks.push(local, body);
    const central = new Uint8Array(46 + name.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true); view.setUint32(16, crc, true); view.setUint32(20, body.length, true); view.setUint32(24, body.length, true);
    view.setUint16(28, name.length, true); view.setUint32(42, offset, true); central.set(name, 46);
    centralChunks.push(central);
    offset += local.length + body.length;
  }
  const centralOffset = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, centralOffset, true);
  return new Blob([...localChunks, ...centralChunks, end], { type: 'application/zip' });
}

function safeFileName(value) { return (value || 'scene').replace(/[\\/:*?"<>|]/g, '_').trim() || 'scene'; }

function cellsRect(start, end, width, height) {
  const minX = Math.min(start.x, end.x); const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y); const maxY = Math.max(start.y, end.y);
  const cells = [];
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) if (x < width && y < height) cells.push({ x, y });
  return cells;
}

function SceneGenerationPage({ config, serverOffline, onOpenSettings }) {
  const [project, setProject] = useState(makeNewProject);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [globalDescriptionOpen, setGlobalDescriptionOpen] = useState(false);
  const [savedProjects, setSavedProjects] = useState([]);
  const [promptLoading, setPromptLoading] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState('');
  const projectRef = useRef(project);
  const paintRef = useRef(null);
  const fileRef = useRef(null);

  const updateProject = useCallback((updater) => {
    setProject((current) => {
      const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
      projectRef.current = next;
      return next;
    });
  }, []);
  const notify = useCallback((message) => {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(''), 3600);
  }, []);

  useEffect(() => { projectRef.current = project; }, [project]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const draft = await sceneGet(DRAFT_ID);
        if (!active) return;
        if (draft) {
          const normalized = migrateProject(draft);
          normalized.id = draft.activeProjectId || (draft.id === DRAFT_ID ? null : draft.id) || null;
          updateProject(normalized);
          await scenePut({ ...normalized, id: DRAFT_ID, activeProjectId: normalized.id, updatedAt: Date.now() });
          if (normalized.id) await scenePut({ ...normalized, savedAt: Date.now() });
        }
      } catch {
        if (active) notify('无法打开场景本机数据库。');
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => { active = false; };
  }, [notify, updateProject]);

  useEffect(() => {
    if (!loaded) return undefined;
    const timer = window.setTimeout(() => {
      const draft = { ...project, id: DRAFT_ID, activeProjectId: project.id || null, updatedAt: Date.now() };
      scenePut(draft).catch(() => notify('场景草稿保存失败，请检查浏览器存储空间。'));
      if (project.id) scenePut({ ...project, savedAt: Date.now() }).catch(() => notify('场景项目自动保存失败。'));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [loaded, project, notify]);

  const metrics = useMemo(() => metricsFor(project), [project]);
  const cellMetrics = useMemo(() => metricsFor(project, project.cellWidthPx), [project]);
  const cells = useMemo(() => Array.from({ length: project.width * project.height }, (_, index) => ({ x: index % project.width, y: Math.floor(index / project.width) })), [project.width, project.height]);
  const orderedRegions = [...project.regions].sort((a, b) => a.layer - b.layer || a.createdAt - b.createdAt);
  const currentLayerRegions = orderedRegions.filter((region) => region.layer === project.selectedLayer);
  const activeRegion = project.regions.find((region) => region.id === project.activeRegionId && region.layer === project.selectedLayer) || null;
  const activeReferenceSource = activeRegion ? regionReferenceSource(activeRegion) : 'none';
  const activeLowerReferenceLayers = activeRegion ? availableLowerReferenceLayers(project, activeRegion.layer) : [];
  const collisionSet = useMemo(() => new Set(project.collisionCells.map(({ x, y }) => cellKey(x, y))), [project.collisionCells]);
  const selectedSet = useMemo(() => new Set(project.selectionCells.map(({ x, y }) => cellKey(x, y))), [project.selectionCells]);
  const occupiedByLayer = useMemo(() => {
    const occupied = new Map();
    project.regions.forEach((region) => {
      region.cells.forEach(({ x, y }) => {
        const key = `${region.layer}:${cellKey(x, y)}`;
        if (!occupied.has(key)) occupied.set(key, region.id);
      });
    });
    return occupied;
  }, [project.regions]);

  const saveProject = async () => {
    const id = project.id || uid();
    const saved = { ...project, id, name: project.name.trim() || '未命名场景', savedAt: Date.now() };
    try {
      await scenePut(saved);
      await sceneDelete(DRAFT_ID);
      updateProject(saved);
      notify('场景项目已保存在本机。');
    } catch (error) { notify(`保存场景失败：${error.message}`); }
  };

  const openProjectPicker = async () => {
    try {
      const sourceProjects = (await sceneList()).filter((item) => item.id !== DRAFT_ID).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      const normalized = sourceProjects.map((saved) => migrateProject(saved));
      for (let index = 0; index < normalized.length; index += 1) {
        if (sourceProjects[index].schemaVersion < 2 || !Array.isArray(sourceProjects[index].regions)) await scenePut({ ...normalized[index], id: sourceProjects[index].id, savedAt: sourceProjects[index].savedAt });
      }
      setSavedProjects(normalized);
      setProjectsOpen(true);
    } catch (error) { notify(`读取本机项目失败：${error.message}`); }
  };

  const loadProject = (saved) => {
    const normalized = migrateProject(saved);
    updateProject({ ...normalized, id: saved.id });
    scenePut({ ...normalized, id: saved.id }).catch(() => notify('项目已打开，但旧项目迁移后的自动保存失败。'));
    setProjectsOpen(false);
    notify(`已打开「${saved.name}」。`);
  };

  const startNewProject = () => {
    if ((project.regions.length || project.collisionCells.length || project.selectionCells.length) && !window.confirm('新建场景并清空当前画布？已保存的项目不会删除。')) return;
    updateProject(makeNewProject());
    notify('已创建空白场景。');
  };

  const hasCellOccupancy = (layer, x, y, ignoredRegionId = '') => {
    const current = projectRef.current;
    return current.regions.some((region) => region.id !== ignoredRegionId && region.layer === layer && region.cells.some((cell) => cell.x === x && cell.y === y));
  };

  const applyPaintCell = (cell) => {
    const current = projectRef.current;
    if (current.tool === 'collisionPaint' || current.tool === 'collisionErase') {
      const shouldAdd = current.tool === 'collisionPaint';
      updateProject((value) => {
        const map = new Map(value.collisionCells.map((item) => [cellKey(item.x, item.y), item]));
        if (shouldAdd) map.set(cellKey(cell.x, cell.y), cell);
        else map.delete(cellKey(cell.x, cell.y));
        return { ...value, collisionCells: [...map.values()] };
      });
      return;
    }
    if (hasCellOccupancy(current.selectedLayer, cell.x, cell.y)) return;
    if (current.tool === 'rectangle' && paintRef.current?.start) {
      const selection = cellsRect(paintRef.current.start, cell, current.width, current.height).filter((item) => !hasCellOccupancy(current.selectedLayer, item.x, item.y));
      updateProject((value) => ({ ...value, selectionCells: selection }));
      return;
    }
    updateProject((value) => {
      const map = new Map(value.selectionCells.map((item) => [cellKey(item.x, item.y), item]));
      map.set(cellKey(cell.x, cell.y), cell);
      return { ...value, selectionCells: [...map.values()] };
    });
  };

  const startPainting = (event, cell) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (projectRef.current.tool === 'rectangle') {
      paintRef.current = { start: cell };
      applyPaintCell(cell);
    } else {
      paintRef.current = { start: cell };
      applyPaintCell(cell);
    }
  };

  const continuePainting = (event, cell) => {
    if (paintRef.current && event.buttons === 1) applyPaintCell(cell);
  };

  useEffect(() => {
    const stop = () => { paintRef.current = null; };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
  }, []);

  const createRegion = () => {
    const current = projectRef.current;
    const uniqueCells = [...new Map(current.selectionCells.map((cell) => [cellKey(cell.x, cell.y), cell])).values()];
    if (!uniqueCells.length) { notify('请先在画布上选择一片格子。'); return; }
    const blocked = uniqueCells.filter((cell) => hasCellOccupancy(current.selectedLayer, cell.x, cell.y));
    if (blocked.length) { notify(`第 ${current.selectedLayer} 层有 ${blocked.length} 格与已有区域重叠，请调整选区或层级。`); return; }
    const region = {
      id: uid(), name: `区域 ${String(current.regions.length + 1).padStart(2, '0')}`, layer: current.selectedLayer,
      cells: uniqueCells, image: '', prompt: '', negativePrompt: '', description: '', referenceImage: '', referenceName: '',
      referenceSource: current.selectedLayer > 0 ? 'lower-layers' : 'none',
      provider: current.imageProvider, model: '', createdAt: Date.now(), updatedAt: Date.now(),
    };
    updateProject((value) => ({ ...value, regions: [...value.regions, region], activeRegionId: region.id, selectionCells: [] }));
    notify('区域已创建，可以填写描述并生成内容。');
  };

  const updateRegion = (patch) => {
    if (!activeRegion) return;
    if ('layer' in patch) {
      const layer = Number(patch.layer);
      const collision = activeRegion.cells.some((cell) => hasCellOccupancy(layer, cell.x, cell.y, activeRegion.id));
      if (collision) { notify(`第 ${layer} 层已有其他区域占用部分格子。`); return; }
    }
    updateProject((current) => ({
      ...current,
      ...(patch.layer !== undefined ? { selectedLayer: Number(patch.layer) } : {}),
      regions: current.regions.map((region) => region.id === activeRegion.id ? { ...region, ...patch, updatedAt: Date.now() } : region),
    }));
  };

  const removeRegion = () => {
    if (!activeRegion) return;
    if (!window.confirm(`删除「${activeRegion.name}」？它的选区和生成图片会一并移除。`)) return;
    updateProject((current) => ({ ...current, regions: current.regions.filter((region) => region.id !== activeRegion.id), activeRegionId: null }));
    notify('区域已删除。');
  };

  const setCanvasDimension = (key, value) => updateProject((current) => {
    const axis = key === 'width' ? 'x' : 'y';
    const required = Math.max(4, ...current.regions.flatMap((region) => region.cells.map((cell) => cell[axis] + 1)), ...current.collisionCells.map((cell) => cell[axis] + 1), ...current.selectionCells.map((cell) => cell[axis] + 1));
    return { ...current, [key]: Math.max(required, Math.max(4, Math.min(64, Math.round(Number(value) || 4)))) };
  });
  const setCellPixelDimension = (key, value) => updateProject((current) => ({ ...current, [key]: Math.max(1, Math.min(4096, Math.round(Number(value) || 1))) }));

  const handleReferenceUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !activeRegion) return;
    const referenceSource = activeReferenceSource === 'specified-image' ? 'specified-image' : 'manual';
    setImporting(true);
    try {
      const image = await normalizeImageFile(file);
      updateRegion({ referenceImage: image, referenceName: file.name, referenceSource });
      notify(referenceSource === 'specified-image' ? '指定图片已添加，可保存为区域图像。' : '参考图已添加到当前区域。');
    } catch (error) { notify(error.message); }
    finally { setImporting(false); }
  };

  const setReferenceFromRegion = (id, referenceSource = 'manual') => {
    if (!id) {
      updateRegion({ referenceImage: '', referenceName: '', referenceSource: referenceSource === 'specified-image' ? referenceSource : 'none' });
      return;
    }
    const source = project.regions.find((region) => region.id === id);
    updateRegion({ referenceImage: regionImage(project, source), referenceName: source?.name || '', referenceSource });
  };

  const saveSpecifiedRegionImage = () => {
    if (!activeRegion?.referenceImage) { notify('请先选择或上传一张指定图片。'); return; }
    updateRegion({ image: activeRegion.referenceImage, provider: 'local', model: '指定图片', updatedAt: Date.now() });
    notify('指定图片已保存为当前区域图像。');
  };

  const getGenerationReference = async (region, width, height, includeKlingGuide = false) => {
    const source = regionReferenceSource(region);
    if (source === 'lower-layers' && region.layer > 0) {
      const result = await renderLowerLayersRegionReference(project, region, width, height, includeKlingGuide);
      return { ...result, kind: 'lower-layers' };
    }
    if (source === 'manual' && region.referenceImage) {
      return { image: region.referenceImage, mask: '', layers: [], kind: 'manual' };
    }
    return { image: '', mask: '', layers: [], kind: 'none' };
  };

  const generatePrompt = async () => {
    if (!activeRegion) return;
    if (serverOffline) { notify('本机服务未启动，无法生成提示词。'); return; }
    if (!config.configured[project.promptProvider]) { notify('请先在服务设置中配置所选服务的 API key。'); onOpenSettings(); return; }
    const geometry = regionGeometry(project, cellMetrics, activeRegion.cells);
    const width = Math.max(1, Math.round(geometry?.width || 1));
    const height = Math.max(1, Math.round(geometry?.height || 1));
    setPromptLoading(true);
    try {
      const reference = await getGenerationReference(activeRegion, width, height);
      const referenceImage = dataUrlParts(reference.image);
      const response = await fetch('/api/scene/prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: project.promptProvider, layout: project.layout, hexOrientation: project.hexOrientation,
          layer: activeRegion.layer, cellCount: activeRegion.cells.length, width: Math.round(geometry?.width || 1), height: Math.round(geometry?.height || 1),
          cellWidthPx: project.cellWidthPx, cellHeightPx: project.cellHeightPx,
          name: activeRegion.name, description: activeRegion.description,
          globalDescription: project.globalDescription,
          globalPositivePrompt: project.globalPositivePrompt,
          globalNegativePrompt: project.globalNegativePrompt,
          referenceImageBase64: referenceImage.imageBase64, referenceMimeType: referenceImage.mimeType,
          referenceKind: reference.kind,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '提示词生成失败。');
      updateRegion({ prompt: result.prompt, negativePrompt: result.negativePrompt });
      notify('区域提示词已生成，可编辑后继续生成图像。');
    } catch (error) { notify(`生成提示词失败：${error.message}`); }
    finally { setPromptLoading(false); }
  };

  const generateRegion = async () => {
    if (!activeRegion) return;
    if (!activeRegion.prompt.trim()) { notify('请先填写提示词，或点击“AI 生成提示词”。'); return; }
    if (serverOffline) { notify('本机服务未启动，无法生成图像。'); return; }
    if (!config.configured[project.imageProvider]) { notify('请先在服务设置中配置所选图像服务的 API key。'); onOpenSettings(); return; }
    const geometry = regionGeometry(project, cellMetrics, activeRegion.cells);
    const width = Math.max(1, Math.round(geometry?.width || 1));
    const height = Math.max(1, Math.round(geometry?.height || 1));
    if (width > 4096 || height > 4096 || width * height > 12_000_000) { notify('该区域图像尺寸过大，请减少选区或调低 Cell 像素尺寸。'); return; }
    setImageLoading(true);
    try {
      const reference = await getGenerationReference(activeRegion, width, height, project.imageProvider === 'kling');
      const useKlingGuide = project.imageProvider === 'kling' && reference.kind === 'lower-layers' && reference.guideImage;
      const referenceImage = dataUrlParts(useKlingGuide ? reference.guideImage : reference.image);
      const referenceMask = dataUrlParts(reference.mask);
      const response = await fetch('/api/scene/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: project.imageProvider, prompt: activeRegion.prompt.trim(), negativePrompt: activeRegion.negativePrompt.trim(),
          globalDescription: project.globalDescription,
          globalPositivePrompt: project.globalPositivePrompt,
          globalNegativePrompt: project.globalNegativePrompt,
          width, height, referenceImageBase64: referenceImage.imageBase64, referenceMimeType: referenceImage.mimeType,
          maskBase64: referenceMask.imageBase64,
          referenceKind: useKlingGuide ? 'lower-layers-marked' : reference.kind,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '区域生成失败。');
      const generated = `data:${result.mimeType || 'image/png'};base64,${result.imageBase64}`;
      const source = await loadImage(generated);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, width, height);
      const image = canvas.toDataURL('image/png');
      updateRegion({ image, provider: project.imageProvider, model: result.model || '', updatedAt: Date.now() });
      notify('区域图像已生成，并按选区形状显示。');
    } catch (error) { notify(`区域生成失败：${error.message}`); }
    finally { setImageLoading(false); }
  };

  const exportUnityResources = async () => {
    if (!project.regions.length && !project.collisionCells.length) { notify('场景中还没有可导出的区域或碰撞格。'); return; }
    setExportLoading(true);
    try {
      const layers = [...new Set(project.regions.map((region) => region.layer))].sort((a, b) => a - b);
      if (!layers.length) layers.push(0);
      let totalPixels = 0;
      const files = [];
      for (const layer of layers) {
        const rendered = await renderLayerPng(project, layer);
        totalPixels += rendered.width * rendered.height;
        if (totalPixels > 64_000_000) throw new Error('分层 PNG 总尺寸过大，请缩小画布或 Cell 像素尺寸后再导出。');
        files.push({ name: `layers/layer-${String(layer).padStart(2, '0')}.png`, bytes: new Uint8Array(await rendered.blob.arrayBuffer()) });
      }
      const scene = {
        format: 'game-asset-factory-scene', version: 1, name: project.name,
        globalDescription: project.globalDescription,
        globalPositivePrompt: project.globalPositivePrompt,
        globalNegativePrompt: project.globalNegativePrompt,
        grid: { width: project.width, height: project.height, layout: project.layout, hexOrientation: project.hexOrientation, cellWidthPx: project.cellWidthPx, cellHeightPx: project.cellHeightPx },
        layers: Array.from({ length: 10 }, (_, index) => ({
          index, name: `图层 ${index}`, visible: project.visibleLayers[index] !== false,
          image: layers.includes(index) ? `layers/layer-${String(index).padStart(2, '0')}.png` : null,
        })),
        exportedLayerIndices: layers,
        regions: project.regions.map((region) => ({
          id: region.id, name: region.name, layer: region.layer, cells: region.cells, prompt: region.prompt,
          negativePrompt: region.negativePrompt, description: region.description, referenceName: region.referenceName || null,
          provider: region.provider, model: region.model, imageInLayerPng: regionImage(project, region) ? `layers/layer-${String(region.layer).padStart(2, '0')}.png` : null,
        })),
        layerVisibility: Object.fromEntries(Array.from({ length: 10 }, (_, layer) => [layer, project.visibleLayers[layer] !== false])),
        collisionCells: project.collisionCells,
      };
      files.push({ name: 'scene.json', bytes: new TextEncoder().encode(JSON.stringify(scene, null, 2)) });
      const blob = zipStore(files);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `${safeFileName(project.name)}-unity-resources.zip`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      notify('Unity 资源 ZIP 已下载，包含分层 PNG 与场景 JSON。');
    } catch (error) { notify(`导出失败：${error.message}`); }
    finally { setExportLoading(false); }
  };

  const selectedTool = TOOLS.find((tool) => tool.id === project.tool) || TOOLS[0];
  const activeTargetGeometry = activeRegion ? regionGeometry(project, cellMetrics, activeRegion.cells) : null;
  return <main className="scene-page region-page">
    <div className="scene-project-toolbar region-project-toolbar">
      <div className="scene-project-heading">
        <span className="scene-eyebrow">SCENE REGION WORKSPACE</span>
        <input aria-label="场景项目名称" value={project.name} onChange={(event) => updateProject((current) => ({ ...current, name: event.target.value }))}/>
        <span className={`scene-save-state ${project.id ? 'saved' : ''}`}>{project.id ? '本机已保存 · 自动同步' : '未命名草稿 · 自动暂存'}</span>
      </div>
      <div className="scene-global-description-control">
        <button className={`scene-global-description-trigger ${project.globalDescription.trim() || project.globalPositivePrompt.trim() || project.globalNegativePrompt.trim() ? 'has-description' : ''}`} aria-expanded={globalDescriptionOpen} aria-haspopup="dialog" onClick={() => setGlobalDescriptionOpen((open) => !open)}>
          <Icon name="spark" size={14}/><span>通用描述词</span><small>{project.globalDescription.trim() || project.globalPositivePrompt.trim() || project.globalNegativePrompt.trim() ? '已设置' : '添加全局规则'}</small>
        </button>
        {globalDescriptionOpen && <section className="scene-global-description-popover" role="dialog" aria-label="通用描述词设置">
          <div className="scene-global-description-heading"><div><strong>通用描述词</strong><small>用于统一当前场景中所有区域的生成规则</small></div><button type="button" aria-label="关闭通用描述词" onClick={() => setGlobalDescriptionOpen(false)}>×</button></div>
          <p>通用描述补充项目背景；正向提示词定义所有区域都要遵循的画面规则，反向提示词定义所有区域都应避免的内容。</p>
          <label className="scene-global-prompt-field"><span>通用描述</span><textarea aria-label="通用描述内容" maxLength={4000} rows={3} value={project.globalDescription} placeholder="例如：用于黑暗奇幻 2D 斜俯视 RPG 的村庄场景，角色比例约为 32×32 像素。" onChange={(event) => updateProject((current) => ({ ...current, globalDescription: event.target.value }))}/></label>
          <label className="scene-global-prompt-field"><span>全局正向提示词</span><textarea aria-label="全局正向提示词" maxLength={4000} rows={3} value={project.globalPositivePrompt} placeholder="例如：统一斜俯视正交视角，低饱和灰绿色调，清晰像素边缘，柔和均匀光照。" onChange={(event) => updateProject((current) => ({ ...current, globalPositivePrompt: event.target.value }))}/></label>
          <label className="scene-global-prompt-field"><span>全局反向提示词</span><textarea aria-label="全局反向提示词" maxLength={4000} rows={3} value={project.globalNegativePrompt} placeholder="例如：不要文字、UI、写实 3D、透视变形、模糊边缘、过饱和颜色或不一致的光照。" onChange={(event) => updateProject((current) => ({ ...current, globalNegativePrompt: event.target.value }))}/></label>
          <div className="scene-global-description-footer"><small>三项设置分别随场景项目自动保存</small><button type="button" onClick={() => setGlobalDescriptionOpen(false)}>完成</button></div>
        </section>}
      </div>
      <div className="scene-project-actions">
        <button className="button button-quiet" onClick={startNewProject}><Icon name="plus" size={15}/>新建场景</button>
        <button className="button button-quiet" onClick={openProjectPicker}><Icon name="folder" size={15}/>打开项目</button>
        <button className="button button-quiet" onClick={exportUnityResources} disabled={exportLoading}><Icon name="zip" size={15}/>{exportLoading ? '导出中…' : '导出 Unity ZIP'}</button>
        <button className="button button-dark" onClick={saveProject}><Icon name="save" size={15}/>保存项目</button>
      </div>
    </div>

    <div className={`scene-workspace region-workspace ${collapsed ? 'library-collapsed' : ''}`}>
      <aside className="scene-library-panel region-list-panel">
        <div className="scene-library-heading">
          {!collapsed && <div><span className="scene-panel-label">生成区域</span><small>{project.regions.length} 个区域 · {project.collisionCells.length} 个碰撞格</small></div>}
          <button className="scene-collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? '展开区域列表' : '折叠区域列表'}>{collapsed ? '›' : '‹'}</button>
        </div>
        {!collapsed && <>
          <div className="region-tool-list" role="toolbar" aria-label="画布工具">
            {TOOLS.map((tool) => <button key={tool.id} className={project.tool === tool.id ? 'active' : ''} title={tool.label} onClick={() => updateProject((current) => ({ ...current, tool: tool.id }))}><Icon name={tool.icon} size={15}/><span>{tool.label}</span></button>)}
          </div>
          <div className="region-layer-heading"><strong>操作图层</strong><small>画布操作目标</small></div>
          <div className="region-layer-control">
            <select aria-label="当前操作图层" value={project.selectedLayer} onChange={(event) => {
              const layer = Number(event.target.value);
              updateProject((current) => {
                const region = current.regions.find((item) => item.layer === layer && item.id === current.activeRegionId) || current.regions.find((item) => item.layer === layer);
                return { ...current, selectedLayer: layer, activeRegionId: region?.id || null };
              });
            }}>
              {Array.from({ length: 10 }, (_, index) => <option value={index} key={index}>图层 {index}（{project.regions.filter((region) => region.layer === index).length} 个区域）</option>)}
            </select>
            <button className={`region-layer-visibility ${project.visibleLayers[project.selectedLayer] === false ? 'hidden' : ''}`} onClick={() => updateProject((current) => ({ ...current, visibleLayers: { ...current.visibleLayers, [current.selectedLayer]: current.visibleLayers[current.selectedLayer] === false } }))} aria-label={`${project.visibleLayers[project.selectedLayer] === false ? '显示' : '隐藏'}图层 ${project.selectedLayer}`} title={`${project.visibleLayers[project.selectedLayer] === false ? '显示' : '隐藏'}当前图层 ${project.selectedLayer}`}><Icon name={project.visibleLayers[project.selectedLayer] === false ? 'eyeOff' : 'eye'} size={15}/></button>
          </div>
          <button className="region-create-button" onClick={createRegion} disabled={!project.selectionCells.length}><Icon name="plus" size={15}/>将选区创建为区域{project.selectionCells.length ? `（${project.selectionCells.length} 格）` : ''}</button>
          <div className="region-list">
            {currentLayerRegions.map((region) => <button key={region.id} className={`region-list-item ${region.id === project.activeRegionId ? 'active' : ''} ${project.visibleLayers[region.layer] === false ? 'layer-hidden' : ''}`} onClick={() => updateProject((current) => ({ ...current, activeRegionId: region.id, selectedLayer: region.layer }))}>
              <span className="region-list-thumb">{regionImage(project, region) ? <img src={regionImage(project, region)} alt=""/> : <span className="region-thumb-empty"><Icon name="rect" size={16}/></span>}</span>
              <span className="region-list-copy"><strong>{region.name}</strong><small>{region.cells.length} 格 · 图层 {region.layer} · {project.visibleLayers[region.layer] === false ? '隐藏' : regionImage(project, region) ? '已生成' : '待生成'}</small></span>
              <span className="region-list-layer">L{region.layer}</span>
            </button>)}
            {!currentLayerRegions.length && <div className="region-empty"><Icon name="rect" size={22}/><strong>当前图层暂无区域</strong><small>在画布上标出需要生成的范围，再创建到图层 {project.selectedLayer}。</small></div>}
          </div>
          <div className="region-list-hint"><Icon name="collision" size={14}/><span>碰撞格可独立标记，不受区域层级限制。</span></div>
        </>}
        {collapsed && <div className="scene-collapsed-count">{project.regions.length}</div>}
      </aside>

      <section className="scene-canvas-panel">
        <div className="scene-canvas-toolbar region-canvas-toolbar">
          <div className="scene-canvas-title"><span className="scene-panel-label">场景画布</span><span>{project.width} × {project.height}</span></div>
          <div className="scene-canvas-options">
            <label title="格子列数"><span>宽</span><input aria-label="画布宽度" type="number" min="4" max="64" value={project.width} onChange={(event) => setCanvasDimension('width', event.target.value)}/></label>
            <label title="格子行数"><span>高</span><input aria-label="画布高度" type="number" min="4" max="64" value={project.height} onChange={(event) => setCanvasDimension('height', event.target.value)}/></label>
            <label className="scene-cell-pixel-field"><span>Cell 宽</span><input aria-label="Cell 宽度（像素）" type="number" min="1" max="4096" value={project.cellWidthPx} onChange={(event) => setCellPixelDimension('cellWidthPx', event.target.value)}/><small>px</small></label>
            <label className="scene-cell-pixel-field"><span>Cell 高</span><input aria-label="Cell 高度（像素）" type="number" min="1" max="4096" value={project.cellHeightPx} onChange={(event) => setCellPixelDimension('cellHeightPx', event.target.value)}/><small>px</small></label>
            <select aria-label="网格布局" value={project.layout} onChange={(event) => updateProject((current) => ({ ...current, layout: event.target.value }))}>{LAYOUTS.map((layout) => <option value={layout.id} key={layout.id}>{layout.label}</option>)}</select>
            {project.layout === 'hexagon' && <select aria-label="六边形方向" value={project.hexOrientation} onChange={(event) => updateProject((current) => ({ ...current, hexOrientation: event.target.value }))}><option value="pointy">Point Top</option><option value="flat">Flat Top</option></select>}
            <div className="zoom-control region-zoom-control" aria-label="画布缩放">
              <button aria-label="缩小画布" title="缩小画布" disabled={canvasZoom <= 0.4} onClick={() => setCanvasZoom((value) => Math.max(0.4, Math.round((value - 0.1) * 10) / 10))}>−</button>
              <button aria-label="重置画布缩放" title="重置为 100%" onClick={() => setCanvasZoom(1)}>{Math.round(canvasZoom * 100)}%</button>
              <button aria-label="放大画布" title="放大画布" disabled={canvasZoom >= 3} onClick={() => setCanvasZoom((value) => Math.min(3, Math.round((value + 0.1) * 10) / 10))}>+</button>
            </div>
            <button className={`region-grid-toggle ${project.showGrid ? 'active' : ''}`} aria-pressed={project.showGrid} aria-label={`${project.showGrid ? '隐藏' : '显示'}网格`} title={`${project.showGrid ? '隐藏' : '显示'}网格`} onClick={() => updateProject((current) => ({ ...current, showGrid: !current.showGrid }))}><Icon name={project.showGrid ? 'eye' : 'eyeOff'} size={14}/><span>网格</span></button>
          </div>
        </div>
        <div className="scene-canvas-viewport">
          <div className="scene-board-zoom-wrapper" style={{ width: metrics.boardWidth * canvasZoom, height: metrics.boardHeight * canvasZoom }}>
          <div className={`scene-board region-board layout-${project.layout} ${project.showGrid ? '' : 'grid-hidden'} ${project.layout === 'hexagon' ? `hex-${project.hexOrientation}` : ''}`} style={{ width: metrics.boardWidth, height: metrics.boardHeight, transform: `scale(${canvasZoom})` }}>
            {cells.map((cell) => {
              const key = cellKey(cell.x, cell.y);
              const selected = selectedSet.has(key);
              const occupied = project.visibleLayers[project.selectedLayer] !== false && occupiedByLayer.has(`${project.selectedLayer}:${key}`);
              return <button key={key} type="button" className={`scene-cell region-grid-cell ${selected ? 'region-cell-selected' : ''} ${occupied ? 'region-cell-occupied' : ''} ${collisionSet.has(key) ? 'region-cell-collision' : ''}`} data-x={cell.x} data-y={cell.y} style={cellStyle(project, metrics, cell)} aria-label={`网格 ${cell.x + 1}, ${cell.y + 1}${collisionSet.has(key) ? '，碰撞格' : ''}`} title={`${cell.x + 1}, ${cell.y + 1}${collisionSet.has(key) ? ' · 碰撞' : ''}`} onPointerDown={(event) => startPainting(event, cell)} onPointerEnter={(event) => continuePainting(event, cell)}/>;
            })}
            {orderedRegions.map((region) => {
              if (project.visibleLayers[region.layer] === false) return null;
              const image = regionImage(project, region);
              if (!image) return null;
              const geometry = regionGeometry(project, metrics, region.cells);
              if (!geometry) return null;
              const clipId = `region-clip-${region.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
              return <svg key={region.id} className={`region-image-layer ${region.id === project.activeRegionId ? 'active' : ''}`} style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height, zIndex: 20 + region.layer }} viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="none" aria-label={`${region.name} 图像`}>
                <defs><clipPath id={clipId}>{geometry.polygons.map((polygon, index) => <polygon key={index} points={polygon.map((point) => `${point.x},${point.y}`).join(' ')}/>)}</clipPath></defs>
                <image href={image} x="0" y="0" width={geometry.width} height={geometry.height} preserveAspectRatio="none" clipPath={`url(#${clipId})`}/>
              </svg>;
            })}
            {orderedRegions.map((region) => {
              if (project.visibleLayers[region.layer] === false) return null;
              const geometry = regionGeometry(project, metrics, region.cells);
              if (!geometry) return null;
              return <svg key={`boundary-${region.id}`} className={`region-boundary-overlay ${region.id === project.activeRegionId ? 'active' : ''}`} style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height, zIndex: 40 + region.layer }} viewBox={`0 0 ${geometry.width} ${geometry.height}`} aria-label={`${region.name} 区域范围`}>
                {geometry.polygons.map((polygon, index) => <polygon key={index} points={polygon.map((point) => `${point.x},${point.y}`).join(' ')}/>) }
              </svg>;
            })}
            {!!project.selectionCells.length && <svg className="region-selection-overlay" style={{ width: metrics.boardWidth, height: metrics.boardHeight, zIndex: 45 }} viewBox={`0 0 ${metrics.boardWidth} ${metrics.boardHeight}`} aria-hidden="true">{project.selectionCells.map((cell) => <polygon key={cellKey(cell.x, cell.y)} points={cellPolygon(project, metrics, cell.x, cell.y).map((point) => `${point.x},${point.y}`).join(' ')}/>)}</svg>}
            {!!project.collisionCells.length && <svg className="region-collision-overlay" style={{ width: metrics.boardWidth, height: metrics.boardHeight, zIndex: 80 }} viewBox={`0 0 ${metrics.boardWidth} ${metrics.boardHeight}`} aria-label="碰撞格标记" aria-hidden="true">
              {project.collisionCells.map((cell) => <polygon key={`collision-${cellKey(cell.x, cell.y)}`} points={cellPolygon(project, metrics, cell.x, cell.y).map((point) => `${point.x},${point.y}`).join(' ')}/>)}
            </svg>}
            {!currentLayerRegions.length && !project.selectionCells.length && <div className="scene-board-hint"><Icon name={selectedTool.icon} size={20}/><strong>{project.tool.startsWith('collision') ? selectedTool.label : '选择一片需要生成的区域'}</strong><span>{project.tool === 'rectangle' ? '在网格上拖动，框出要描述和生成的范围。' : project.tool.startsWith('collision') ? '点击或拖动网格，单独绘制碰撞标记。' : '画笔连续涂选格子，再创建区域并填写生成描述。'}</span></div>}
          </div>
          </div>
        </div>
        <div className="scene-canvas-footer"><span><i/>{selectedTool.label} · {LAYOUTS.find((layout) => layout.id === project.layout)?.label}{project.layout === 'hexagon' ? ` · ${project.hexOrientation === 'pointy' ? 'Point Top' : 'Flat Top'}` : ''}</span><span>{project.regions.length} 个区域 · {project.collisionCells.length} 个碰撞格</span></div>
      </section>

      <aside className="scene-settings-panel region-settings-panel">
        {activeRegion ? <>
          <div className="scene-settings-heading"><div><span className="scene-eyebrow">REGION DATA</span><h2>区域生成设置</h2></div><button className="scene-delete-asset" onClick={removeRegion} title="删除区域" aria-label="删除区域"><Icon name="trash" size={15}/></button></div>
          <label className="scene-field"><span>区域名称</span><input value={activeRegion.name} onChange={(event) => updateRegion({ name: event.target.value })}/></label>
          <label className="scene-field"><span>所属图层（数值越高越靠上）</span><select value={activeRegion.layer} onChange={(event) => {
            const layer = Number(event.target.value);
            let referenceSource = activeReferenceSource;
            if (layer > 0 && referenceSource === 'none' && !activeRegion.referenceImage) referenceSource = 'lower-layers';
            if (layer === 0 && referenceSource === 'lower-layers') referenceSource = 'none';
            updateRegion({ layer, referenceSource });
          }}>{Array.from({ length: 10 }, (_, index) => <option value={index} key={index}>图层 {index}</option>)}</select></label>
          <div className="region-info-strip"><span>{activeRegion.cells.length} 个格子</span><span>{activeTargetGeometry ? `${Math.round(activeTargetGeometry.width)} × ${Math.round(activeTargetGeometry.height)} px` : ''}</span><span>{activeReferenceSource === 'specified-image' ? (activeRegion.referenceImage && regionImage(project, activeRegion) === activeRegion.referenceImage ? '已保存指定图像' : activeRegion.referenceImage ? '待保存指定图像' : '尚未指定图像') : regionImage(project, activeRegion) ? '已生成图像' : '尚未生成'}</span></div>

          <div className="scene-field-block">
            <span className="scene-field-title">底图参考</span>
            <select className="scene-select" value={activeReferenceSource} onChange={(event) => updateRegion({ referenceSource: event.target.value })}>
              {activeRegion.layer > 0 && <option value="lower-layers">自动合成下方可见图层</option>}
              <option value="manual">使用手动参考图（AI 参考）</option>
              <option value="specified-image">指定图片（直接作为区域图像）</option>
              <option value="none">不使用参考图</option>
            </select>
            {activeReferenceSource === 'lower-layers' && <div className={`scene-reference-guidance ${activeLowerReferenceLayers.length ? '' : 'is-empty'}`}>
              {activeLowerReferenceLayers.length
                ? `将自动合成图层 ${activeLowerReferenceLayers.join('、')} 作为底图，提示词和生成请求都会参考它。${project.imageProvider === 'openai' ? ' 当前 OpenAI 服务还会接收选区遮罩。' : project.imageProvider === 'kling' ? ' 提交可灵时会把当前格子叠加为洋红色定位标记，结果仍按区域边界合成。' : ' 生成结果会按当前区域边界合成。'}`
                : '下方可见图层还没有已生成图像；先生成底图，或改用手动参考图。'}
            </div>}
            {activeReferenceSource === 'specified-image' && <div className="scene-reference-guidance">
              选择或上传一张图片，保存后直接用作当前区域图像，并按选区边界显示；此模式不调用 AI。
            </div>}
            {(activeReferenceSource === 'manual' || activeReferenceSource === 'specified-image') && <>
              <select className="scene-select scene-reference-picker" value={project.regions.find((region) => regionImage(project, region) && regionImage(project, region) === activeRegion.referenceImage)?.id || (activeRegion.referenceImage ? '__uploaded__' : '')} onChange={(event) => {
                if (event.target.value === '__browse__') {
                  fileRef.current?.click();
                  event.target.value = project.regions.find((region) => regionImage(project, region) && regionImage(project, region) === activeRegion.referenceImage)?.id || (activeRegion.referenceImage ? '__uploaded__' : '');
                  return;
                }
                setReferenceFromRegion(event.target.value, activeReferenceSource);
              }}>
                <option value="">{activeReferenceSource === 'specified-image' ? '选择已有区域图片' : '选择已生成区域作为参考图'}</option>
                {activeReferenceSource === 'specified-image' && <option value="__browse__">从电脑选择图片…</option>}
                {activeRegion.referenceImage && <option value="__uploaded__" disabled>{activeRegion.referenceName || (activeReferenceSource === 'specified-image' ? '已指定图片' : '已上传参考图')}</option>}
                {project.regions.filter((region) => region.id !== activeRegion.id && regionImage(project, region)).map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}
              </select>
              {activeRegion.referenceImage && <div className="scene-reference-preview"><img src={activeRegion.referenceImage} alt={activeReferenceSource === 'specified-image' ? '指定区域图像预览' : '参考图预览'}/><span>{activeRegion.referenceName || (activeReferenceSource === 'specified-image' ? '指定图片' : '参考图')}</span><button onClick={() => updateRegion({ referenceImage: '', referenceName: '', referenceSource: activeReferenceSource === 'specified-image' ? 'specified-image' : 'none' })} aria-label="移除图片">×</button></div>}
              <button className="scene-upload-reference" onClick={() => fileRef.current?.click()} disabled={importing}><Icon name="upload" size={14}/>{importing ? '正在读取…' : activeReferenceSource === 'specified-image' ? '上传指定图片 PNG / JPEG / WebP' : '上传 PNG / JPEG / WebP'}</button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handleReferenceUpload}/>
            </>}
          </div>

          {activeReferenceSource !== 'specified-image' && <>
          <label className="scene-field"><span>区域内容描述</span><textarea rows="3" value={activeRegion.description} placeholder="例如：一片长满苔藓的石质庭院，左侧有向北延伸的道路。" onChange={(event) => updateRegion({ description: event.target.value })}/></label>
          <div className="scene-prompt-provider-row"><span>提示词 AI</span><select value={project.promptProvider} onChange={(event) => updateProject((current) => ({ ...current, promptProvider: event.target.value }))}><option value="gemini">Gemini</option><option value="openai">OpenAI</option><option value="qwen">千问</option></select><span className={`scene-key-dot ${config.configured[project.promptProvider] ? 'ready' : ''}`} title={config.configured[project.promptProvider] ? 'API key 已配置' : '尚未配置 API key'}/></div>
          <button className="scene-draft-prompt" onClick={generatePrompt} disabled={promptLoading || serverOffline}>{promptLoading ? <><span className="spinner"/>正在编写区域提示词…</> : <><Icon name="spark" size={15}/>为区域生成提示词</>}</button>
          <label className="scene-field scene-prompt-field"><span>正向提示词</span><textarea rows="4" value={activeRegion.prompt} placeholder="描述这片区域的内容、视角、风格和空间布局。" onChange={(event) => updateRegion({ prompt: event.target.value })}/></label>
          <label className="scene-field scene-prompt-field"><span>反向提示词</span><textarea rows="3" value={activeRegion.negativePrompt} placeholder="例如：文字、UI、边框、孤立物件、视角不一致。" onChange={(event) => updateRegion({ negativePrompt: event.target.value })}/></label>
          <label className="scene-image-provider"><span>图像服务</span><select value={project.imageProvider} onChange={(event) => updateProject((current) => ({ ...current, imageProvider: event.target.value }))}><option value="gemini">Gemini</option><option value="openai">OpenAI</option><option value="qwen">千问</option><option value="kling">可灵</option></select></label>
          <button className="scene-generate-tile region-generate-button" onClick={generateRegion} disabled={imageLoading || serverOffline}>{imageLoading ? <><span className="spinner light"/>正在生成区域…</> : <><Icon name="spark" size={16}/>{regionImage(project, activeRegion) ? '重新生成区域图像' : '生成区域图像'}</>}</button>
          {serverOffline && <div className="scene-offline-note">本机服务未启动，请先运行 <code>npm run dev</code>。</div>}
          {!serverOffline && !config.configured[project.imageProvider] && <div className="scene-offline-note">所选服务尚未配置 API key。<button onClick={onOpenSettings}>打开服务设置</button></div>}
          </>}
          {activeReferenceSource === 'specified-image' && <button className="scene-generate-tile region-generate-button" onClick={saveSpecifiedRegionImage} disabled={!activeRegion.referenceImage || importing}><Icon name="save" size={16}/>保存区域图像</button>}
        </> : <div className="region-no-active"><span><Icon name="rect" size={22}/></span><strong>{project.selectionCells.length ? '选区已就绪' : '还没有选中区域'}</strong><small>{project.selectionCells.length ? `当前选择 ${project.selectionCells.length} 格；点击左侧“创建为区域”，再添加生成描述。` : '在左侧选择图层、画笔或矩形框选，再在地图上标出需要生成的内容。图层显示和碰撞格可以独立设置。'}</small></div>}
      </aside>
    </div>

    {projectsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectsOpen(false); }}>
      <section className="modal-card project-modal" role="dialog" aria-modal="true" aria-labelledby="scene-projects-title">
        <div className="modal-header"><div className="modal-icon"><Icon name="folder" size={19}/></div><div><span className="panel-eyebrow">LOCAL SCENE PROJECTS</span><h2 id="scene-projects-title">打开场景项目</h2></div><button className="icon-button" onClick={() => setProjectsOpen(false)} aria-label="关闭">×</button></div>
        {savedProjects.length ? <div className="saved-project-list scene-saved-project-list">{savedProjects.map((saved) => { const thumbnail = saved.regions?.map((region) => regionImage(saved, region)).find(Boolean); return <button key={saved.id} className="saved-project-row" onClick={() => loadProject(saved)}><span className="saved-project-thumb">{thumbnail ? <img src={thumbnail} alt=""/> : <Icon name="rect"/>}</span><span className="saved-project-copy"><strong>{saved.name || '未命名场景'}</strong><small>{saved.regions?.length || 0} 个区域 · {saved.width} × {saved.height}</small></span><span className="saved-project-date">{saved.savedAt ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(saved.savedAt)) : ''}</span></button>; })}</div> : <div className="no-projects"><Icon name="folder"/><strong>还没有保存的场景项目</strong><span>选择网格区域并保存项目，即可在本机继续编辑。</span></div>}
        <div className="modal-footer"><span className="local-storage-note">场景图像保存在此浏览器的本机数据库</span><button className="button button-quiet" onClick={() => setProjectsOpen(false)}>关闭</button></div>
      </section>
    </div>}

    {toast && <div className="toast-message"><span className="toast-mark"><Icon name="spark" size={13}/></span>{toast}</div>}
  </main>;
}

export default SceneGenerationPage;
