import { normalizeScaleReference } from './scale.js';
import { collectAssetIds, DRAFT_ID, FORMAT, newProject, normalizeProject, uid } from './core.js';
const DB_NAME = 'terrain-workshop-local';
let dbPromise;
function db() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of ['projects', 'assets']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
    };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); dbPromise = null; }; resolve(req.result); };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('请关闭其他旧版地图页面后重试。')); };
  });
  return dbPromise;
}
async function store(name, mode, action) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(name, mode), req = action(tx.objectStore(name));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('本地保存被中断。'));
  });
}
export class AssetStore {
  constructor() { this.blobs = new Map(); this.urls = new Map(); }
  async put(blob, id = uid()) {
    if (!(blob instanceof Blob) || !blob.size) throw new Error('图片内容为空。');
    await store('assets', 'readwrite', (s) => s.put({ id, blob }));
    this.blobs.set(id, blob); return id;
  }
  async putDataUrl(url) { return this.put(await (await fetch(url)).blob()); }
  async get(id) {
    if (!id) return null;
    if (this.blobs.has(id)) return this.blobs.get(id);
    const saved = await store('assets', 'readonly', (s) => s.get(id));
    if (!saved?.blob) throw new Error(`缺少地图素材 ${id}，请重新导入完整项目。`);
    this.blobs.set(id, saved.blob); return saved.blob;
  }
  async url(id) {
    if (!id) return '';
    if (!this.urls.has(id)) this.urls.set(id, URL.createObjectURL(await this.get(id)));
    return this.urls.get(id);
  }
  release() { for (const url of this.urls.values()) URL.revokeObjectURL(url); this.urls.clear(); this.blobs.clear(); }
}
export const listProjects = async () => (await store('projects', 'readonly', (s) => s.getAll())).filter((p) => p.id !== DRAFT_ID).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
export const readProject = (id) => store('projects', 'readonly', (s) => s.get(id));
export async function saveProject(p, draft = false) {
  const value = { ...p, savedAt: Date.now(), id: draft ? DRAFT_ID : p.id || uid() };
  if (draft) value.projectId = p.id;
  await store('projects', 'readwrite', (s) => s.put(value));
  return draft ? p : value;
}
export async function migrateProject(saved, assets) {
  if (saved.schemaVersion === 2) {
    const value = normalizeProject(saved);
    if (saved.id === DRAFT_ID) value.id = saved.projectId || null;
    return value;
  }
  const p = { ...newProject(), scaleReference: normalizeScaleReference(), name: `${saved.name || '旧地图'}（升级副本）`, legacySourceId: saved.id, overlapX: 0, overlapY: 0,
    tileWidth: saved.tileWidth || saved.tiles?.[0]?.width || 1024, tileHeight: saved.tileHeight || saved.tiles?.[0]?.height || 1024 };
  for (const tile of saved.tiles || []) {
    const originalId = await assets.putDataUrl(tile.image);
    p.tiles.push({ id: tile.id || uid(), x: tile.x, y: tile.y, px: tile.x * p.tileWidth, py: tile.y * p.tileHeight,
      width: p.tileWidth, height: p.tileHeight, originalId, name: tile.name, kind: tile.kind, addedAt: tile.addedAt || Date.now() });
  }
  return p;
}
export async function portableFiles(p, assets) {
  const ids = collectAssetIds(p), files = {}; let total = 0;
  for (const id of ids) { const blob = await assets.get(id); total += blob.size; if (total > 512 * 1024 * 1024) throw new Error('项目素材超过 512 MB，请减少图块，或使用分块素材 ZIP 导出。'); files[`assets/${id}.png`] = new Uint8Array(await blob.arrayBuffer()); }
  const clean = { ...p, id: null, format: FORMAT, exportedAt: new Date().toISOString() };
  files['project.json'] = new TextEncoder().encode(JSON.stringify(clean));
  return files;
}
export async function importPortable(files, assets) {
  if (!files['project.json']) throw new Error('ZIP 中没有 project.json，请选择地图项目 ZIP。');
  const saved = JSON.parse(new TextDecoder().decode(files['project.json']));
  if (saved.format !== FORMAT || saved.schemaVersion !== 2 || !Array.isArray(saved.tiles) || saved.tiles.length > 2000) throw new Error('项目格式或版本不受支持。');
  if (!Number.isFinite(saved.tileWidth) || !Number.isFinite(saved.tileHeight) || saved.tileWidth <= 0 || saved.tileHeight <= 0 || saved.tileWidth > 8192 || saved.tileHeight > 8192) throw new Error('项目图块尺寸无效。');
  const ids = collectAssetIds(saved), remap = new Map();
  for (const id of ids) {
    const data = files[`assets/${id}.png`];
    if (!data || data.length > 128 * 1024 * 1024) throw new Error(`项目素材缺失或过大：${id}`);
    // Portable asset paths stay stable; raw provider results may contain JPEG bytes.
    const mimeType = data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 ? 'image/webp' : 'image/png';
    const blob = new Blob([data], { type: mimeType }), bitmap = await createImageBitmap(blob);
    const validSize = bitmap.width <= 8192 && bitmap.height <= 8192; bitmap.close();
    if (!validSize) throw new Error('项目素材尺寸超过 8192 px。');
    remap.set(id, await assets.put(blob));
  }
  const replace = (value) => {
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' && remap.has(v) ? remap.get(v) : replace(v)]));
    return value;
  };
  return normalizeProject({ ...replace(saved), id: null });
}
