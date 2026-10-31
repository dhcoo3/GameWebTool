const definitions = [
  ['ground', '草、花、碎石', '地面点缀', 2, 9, null, 'grass/flowers/gravel'],
  ['barrel', '木桶、普通箱子', '道具与障碍', 11, 20, [11, 20], 'barrels/crates'],
  ['fence', '大箱子、矮围栏', '道具与障碍', 18, 27, null, 'large crates/low fences'],
  ['rock', '大石头', '道具与障碍', 18, 45, null, 'rocks'],
  ['bush', '灌木', '植物', 14, 27, [22, 40], 'bushes'],
  ['smallTree', '小树', '植物', 45, 62, [36, 54], 'small trees'],
  ['tree', '成熟树', '植物', 72, 107, [54, 90], 'mature trees'],
  ['door', '普通可通行门洞', '建筑与入口', 52, 60, [28, 40], 'door openings'],
  ['hut', '小屋', '建筑与入口', 81, 126, null, 'huts'],
  ['house', '普通民居', '建筑与入口', 107, 162, null, 'houses'],
  ['hall', '大厅、商店', '建筑与入口', 126, 215, null, 'halls/shops'],
];
export const OBJECT_DEFINITIONS = definitions.map(([id, name, group, min, max, width, promptName]) => ({ id, name, group, height: { min, max }, width: width ? { min: width[0], max: width[1] } : null, promptName }));
const positive = (v, fallback) => Number.isFinite(v) && v > 0 ? Math.min(8192, Math.max(1, Math.round(v))) : fallback;
const range = (v, fallback) => { const min = positive(v?.min, fallback.min); return { min, max: Math.max(min, positive(v?.max, fallback.max)) }; };
export function normalizeObjectSizes(value, legacy = {}) {
  const entries = Array.isArray(value?.entries) ? value.entries : null;
  const builtin = OBJECT_DEFINITIONS.map((d) => {
    const existing = entries?.find((e) => e.id === d.id);
    let height = d.height, width = d.width;
    if (!entries && d.id === 'door') { height = { min: legacy.doorHeightPx || 120, max: legacy.doorHeightPx || 120 }; width = { min: legacy.doorWidthPx || 64, max: legacy.doorWidthPx || 64 }; }
    if (!entries && d.id === 'tree') { height = { min: legacy.treeMinHeightPx || 192, max: legacy.treeMaxHeightPx || 384 }; width = null; }
    return { id: d.id, name: d.name, enabled: existing ? existing.enabled === true : !entries && ['door', 'tree'].includes(d.id), height: range(existing?.height, height), width: existing ? existing.width ? range(existing.width, d.width || { min: 1, max: 1 }) : null : width ? { ...width } : null };
  });
  const ids = new Set(builtin.map((e) => e.id));
  const custom = (entries || []).filter((e) => e && typeof e.id === 'string' && !ids.has(e.id) && e.id.startsWith('custom-')).flatMap((e) => {
    if (ids.has(e.id)) return []; ids.add(e.id);
    return [{ id: e.id, name: String(e.name || '自定义物件').trim().slice(0, 80) || '自定义物件', enabled: e.enabled === true, height: range(e.height, { min: 1, max: 1 }), width: e.width ? range(e.width, { min: 1, max: 1 }) : null }];
  });
  return { version: 1, rulerHeightPx: positive(value?.rulerHeightPx, legacy.heightPx || 96), entries: [...builtin, ...custom] };
}
export function standardObjectSizes(custom = []) {
  return { version: 1, rulerHeightPx: 44, entries: [...OBJECT_DEFINITIONS.map((d) => ({ id: d.id, name: d.name, enabled: true, height: { ...d.height }, width: d.width ? { ...d.width } : null })), ...custom] };
}
export function applySizeStandard(value) {
  return { ...value, enabled: true, environmentRulesEnabled: true, heightPx: 44, widthPx: 28, objectSizes: standardObjectSizes((value.objectSizes?.entries || []).filter((e) => e.id.startsWith('custom-'))) };
}
export function rescaleObjectSizes(value) {
  const library = normalizeObjectSizes(value.objectSizes, value), ratio = value.heightPx / library.rulerHeightPx;
  const scale = (r) => r ? { min: Math.min(8192, Math.max(1, Math.round(r.min * ratio))), max: Math.min(8192, Math.max(1, Math.round(r.max * ratio))) } : null;
  return { ...value, roadWidthPx: Math.min(8192, Math.max(1, Math.round(value.roadWidthPx * ratio))), objectSizes: { ...library, rulerHeightPx: value.heightPx, entries: library.entries.map((e) => ({ ...e, height: scale(e.height), width: scale(e.width) })) } };
}
export function validateObjectSizes(value) {
  const bad = () => { throw Object.assign(new Error('物件尺寸库参数无效，请检查名称、版本及宽高范围。'), { status: 400 }); };
  if (!value || value.version !== 1 || !Array.isArray(value.entries) || !Number.isFinite(value.rulerHeightPx) || value.rulerHeightPx <= 0 || value.rulerHeightPx > 8192) bad();
  const ids = new Set();
  for (const e of value.entries) {
    if (!e || typeof e.id !== 'string' || ids.has(e.id) || !OBJECT_DEFINITIONS.some((d) => d.id === e.id) && !e.id.startsWith('custom-') || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 80 || typeof e.enabled !== 'boolean') bad();
    ids.add(e.id);
    for (const r of [e.height, ...(e.width == null ? [] : [e.width])]) if (!r || !Number.isFinite(r.min) || !Number.isFinite(r.max) || r.min <= 0 || r.max > 8192 || r.max < r.min) bad();
  }
}
