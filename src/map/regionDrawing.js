// Screen-space hit testing keeps polygon closure usable at every canvas zoom.
export const nearPolygonStart = (points, point, zoom) => points.length >= 3 && Math.hypot(point.x - points[0].x, point.y - points[0].y) * zoom <= 10;
export const emptyPolygonDraft = () => ({ points: [], redo: [], active: false });
export function polygonDraftAction(draft, action, point) {
  if (action === 'cancel') return emptyPolygonDraft();
  if (action === 'add') return { points: [...draft.points, point], redo: [], active: true };
  if (action === 'undo' && draft.points.length) return { points: draft.points.slice(0, -1), redo: [...draft.redo, draft.points.at(-1)], active: true };
  if (action === 'redo' && draft.redo.length) return { points: [...draft.points, draft.redo.at(-1)], redo: draft.redo.slice(0, -1), active: true };
  return draft;
}
export function regionPolygon(points) {
  const clean = [];
  for (const p of points || []) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return null;
    if (!clean.length || Math.hypot(p.x - clean.at(-1).x, p.y - clean.at(-1).y) > .5) clean.push({ x: p.x, y: p.y });
  }
  if (clean.length > 1 && Math.hypot(clean[0].x - clean.at(-1).x, clean[0].y - clean.at(-1).y) <= .5) clean.pop();
  if (new Set(clean.map((p) => `${p.x},${p.y}`)).size < 3) return null;
  const area = clean.reduce((sum, p, i) => { const next = clean[(i + 1) % clean.length]; return sum + p.x * next.y - next.x * p.y; }, 0);
  return Math.abs(area) >= 2 ? clean : null;
}
