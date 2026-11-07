const DB_NAME = 'ui-production-local';
const DB_VERSION = 1;
let connectionPromise;

function openDb() {
  if (!connectionPromise) connectionPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connectionPromise = null; }; resolve(request.result); };
    request.onerror = () => { connectionPromise = null; reject(request.error); };
    request.onblocked = () => { connectionPromise = null; reject(new Error('请关闭其他 UI 制作页面后重试。')); };
  });
  return connectionPromise;
}

function withStore(name, mode, operation) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode), request = operation(tx.objectStore(name));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('本地项目保存失败。'));
  }));
}

function uid() { return globalThis.crypto?.randomUUID?.() || `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export async function putUiAsset(blob) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('图片内容为空。');
  const id = uid();
  await withStore('assets', 'readwrite', (store) => store.put({ id, blob }));
  return id;
}

export async function getUiAsset(id) {
  if (!id) return null;
  const saved = await withStore('assets', 'readonly', (store) => store.get(id));
  if (!saved?.blob) throw new Error('找不到本地 UI 图片，请重新导入或生成。');
  return saved.blob;
}

export const listUiProjects = () => withStore('projects', 'readonly', (store) => store.getAll());
export const saveUiProject = (project) => withStore('projects', 'readwrite', (store) => store.put({ ...project, savedAt: Date.now() }));
export function uiProjectAssetIds(project) {
  const ids = new Set([project?.sourceAssetId, project?.originalAssetId].filter(Boolean));
  for (const id of project?.blobIds || []) ids.add(id);
  for (const asset of project?.assets || []) {
    if (asset.maskAssetId) ids.add(asset.maskAssetId);
    for (const candidate of asset.maskCandidates || []) if (candidate.maskAssetId) ids.add(candidate.maskAssetId);
  }
  for (const restoration of Object.values(project?.restorations || {}))
    for (const key of ['maskAssetId', 'rawAssetId', 'normalizedAssetId']) if (restoration[key]) ids.add(restoration[key]);
  return ids;
}
export async function deleteUiProject(id) {
  const project = await withStore('projects', 'readonly', (store) => store.get(id));
  await withStore('projects', 'readwrite', (store) => store.delete(id));
  const assetIds = uiProjectAssetIds(project);
  if (!assetIds.size) return;
  const remaining = await listUiProjects(), stillUsed = new Set();
  for (const item of remaining) for (const assetId of uiProjectAssetIds(item)) stillUsed.add(assetId);
  const orphaned = [...assetIds].filter((assetId) => !stillUsed.has(assetId));
  if (orphaned.length) await withStore('assets', 'readwrite', (store) => orphaned.forEach((assetId) => store.delete(assetId)));
}
export function createUiId() { return uid(); }
