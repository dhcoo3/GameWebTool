export const GRID_LAYOUTS = [
  { id: 'rectangle', label: '矩形' },
  { id: 'isometric', label: '等距' },
  { id: 'isometricZAsY', label: '等距 Z-as-Y' },
  { id: 'hexagon', label: '六边形' },
];

export function normalizeGrid(value = {}) {
  const saved = value && typeof value === 'object' ? value : {};
  const number = (key, fallback, min, max) => {
    const parsed = saved[key] == null || saved[key] === '' ? fallback : Number(saved[key]);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
  };
  return {
    width: number('width', 32, 4, 64), height: number('height', 32, 4, 64),
    cellWidthPx: number('cellWidthPx', 100, 1, 4096), cellHeightPx: number('cellHeightPx', 100, 1, 4096),
    layout: GRID_LAYOUTS.some((layout) => layout.id === saved.layout) ? saved.layout : 'rectangle',
    hexOrientation: saved.hexOrientation === 'flat' ? 'flat' : 'pointy', visible: saved.visible !== false,
  };
}

export function gridMetrics(project, cellWidth = 18) {
  const width = project.width;
  const height = project.height;
  const layout = project.layout;
  const cellWidthPx = Math.max(1, Number(project.cellWidthPx) || 100);
  const cellHeightPx = Math.max(1, Number(project.cellHeightPx) || 100);
  const cellHeight = cellWidth * cellHeightPx / cellWidthPx;
  if (layout === 'isometric' || layout === 'isometricZAsY') {
    return { cellWidth, cellHeight, boardWidth: (width + height) * cellWidth / 2, boardHeight: (width + height) * cellHeight / 2 };
  }
  if (layout === 'hexagon' && project.hexOrientation === 'pointy') {
    const shapeWidth = cellWidth;
    const shapeHeight = cellHeight * 1.08;
    const stepY = shapeHeight * 0.75;
    return { cellWidth: shapeWidth, cellHeight: shapeHeight, stepX: shapeWidth, stepY, boardWidth: width * shapeWidth + shapeWidth / 2, boardHeight: (height - 1) * stepY + shapeHeight };
  }
  if (layout === 'hexagon') {
    const shapeWidth = cellWidth * 1.08;
    const shapeHeight = cellHeight;
    const stepX = shapeWidth * 0.75;
    return { cellWidth: shapeWidth, cellHeight: shapeHeight, stepX, stepY: shapeHeight, boardWidth: (width - 1) * stepX + shapeWidth, boardHeight: height * shapeHeight + shapeHeight / 2 };
  }
  return { cellWidth, cellHeight, boardWidth: width * cellWidth, boardHeight: height * cellHeight };
}

export function gridPoint(project, metrics, x, y) {
  if (project.layout === 'isometric' || project.layout === 'isometricZAsY') {
    return { x: (x - y + project.height) * metrics.cellWidth / 2, y: (x + y) * metrics.cellHeight / 2 };
  }
  if (project.layout === 'hexagon' && project.hexOrientation === 'pointy') {
    const row = Math.floor(y);
    return { x: x * metrics.stepX + ((row % 2 + 2) % 2) * metrics.stepX / 2 + metrics.cellWidth / 2, y: y * metrics.stepY + metrics.cellHeight / 2 };
  }
  if (project.layout === 'hexagon') {
    const column = Math.floor(x);
    return { x: x * metrics.stepX + metrics.cellWidth / 2, y: y * metrics.stepY + ((column % 2 + 2) % 2) * metrics.cellHeight / 2 + metrics.cellHeight / 2 };
  }
  return { x: x * metrics.cellWidth, y: y * metrics.cellHeight };
}

export function gridCellPolygon(project, metrics, x, y) {
  if (project.layout === 'isometric' || project.layout === 'isometricZAsY') {
    return [gridPoint(project, metrics, x, y), gridPoint(project, metrics, x + 1, y), gridPoint(project, metrics, x + 1, y + 1), gridPoint(project, metrics, x, y + 1)];
  }
  if (project.layout === 'hexagon') {
    const center = gridPoint(project, metrics, x, y);
    if (project.hexOrientation === 'pointy') return [
      { x: center.x, y: center.y - metrics.cellHeight / 2 }, { x: center.x + metrics.cellWidth / 2, y: center.y - metrics.cellHeight / 4 },
      { x: center.x + metrics.cellWidth / 2, y: center.y + metrics.cellHeight / 4 }, { x: center.x, y: center.y + metrics.cellHeight / 2 },
      { x: center.x - metrics.cellWidth / 2, y: center.y + metrics.cellHeight / 4 }, { x: center.x - metrics.cellWidth / 2, y: center.y - metrics.cellHeight / 4 },
    ];
    return [
      { x: center.x - metrics.cellWidth / 4, y: center.y - metrics.cellHeight / 2 }, { x: center.x + metrics.cellWidth / 4, y: center.y - metrics.cellHeight / 2 },
      { x: center.x + metrics.cellWidth / 2, y: center.y }, { x: center.x + metrics.cellWidth / 4, y: center.y + metrics.cellHeight / 2 },
      { x: center.x - metrics.cellWidth / 4, y: center.y + metrics.cellHeight / 2 }, { x: center.x - metrics.cellWidth / 2, y: center.y },
    ];
  }
  return [gridPoint(project, metrics, x, y), gridPoint(project, metrics, x + 1, y), gridPoint(project, metrics, x + 1, y + 1), gridPoint(project, metrics, x, y + 1)];
}

function containsPoint(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i], cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-7 && point.x >= Math.min(a.x, b.x) - 1e-7 && point.x <= Math.max(a.x, b.x) + 1e-7 && point.y >= Math.min(a.y, b.y) - 1e-7 && point.y <= Math.max(a.y, b.y) + 1e-7) return true;
    if ((b.y > point.y) !== (a.y > point.y) && point.x < (a.x - b.x) * (point.y - b.y) / (a.y - b.y) + b.x) inside = !inside;
  }
  return inside;
}

export function gridCellAtPoint(project, metrics, point) {
  const candidates = [];
  if (project.layout === 'rectangle') {
    candidates.push([Math.floor(point.x / metrics.cellWidth), Math.floor(point.y / metrics.cellHeight)]);
  } else if (project.layout === 'isometric' || project.layout === 'isometricZAsY') {
    const x = point.x / metrics.cellWidth + point.y / metrics.cellHeight - project.height / 2;
    const y = point.y / metrics.cellHeight - point.x / metrics.cellWidth + project.height / 2;
    const cx = Math.floor(x), cy = Math.floor(y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) candidates.push([cx + dx, cy + dy]);
  } else if (project.hexOrientation === 'pointy') {
    const row = Math.floor((point.y - metrics.cellHeight / 2) / metrics.stepY);
    for (let dy = -1; dy <= 1; dy++) {
      const y = row + dy, offset = ((y % 2 + 2) % 2) * metrics.stepX / 2;
      const col = Math.floor((point.x - offset - metrics.cellWidth / 2) / metrics.stepX);
      for (let dx = -1; dx <= 1; dx++) candidates.push([col + dx, y]);
    }
  } else {
    const col = Math.floor((point.x - metrics.cellWidth / 2) / metrics.stepX);
    for (let dx = -1; dx <= 1; dx++) {
      const x = col + dx, offset = ((x % 2 + 2) % 2) * metrics.cellHeight / 2;
      const row = Math.floor((point.y - offset - metrics.cellHeight / 2) / metrics.stepY);
      for (let dy = -1; dy <= 1; dy++) candidates.push([x, row + dy]);
    }
  }
  const visited = new Set();
  for (const [x, y] of candidates) {
    const key = `${x},${y}`;
    if (visited.has(key) || x < 0 || y < 0 || x >= project.width || y >= project.height) continue;
    visited.add(key);
    if (containsPoint(point, gridCellPolygon(project, metrics, x, y))) return { x, y };
  }
  return null;
}

export function traceGridCells(from, to, project, metrics, origin = { x: 0, y: 0 }) {
  const start = { x: from.x - origin.x, y: from.y - origin.y }, end = { x: to.x - origin.x, y: to.y - origin.y };
  const cells = [], seen = new Set();
  const add = (cell) => {
    if (!cell || cell.x < 0 || cell.y < 0 || cell.x >= project.width || cell.y >= project.height) return;
    const key = `${cell.x},${cell.y}`;
    if (!seen.has(key)) { seen.add(key); cells.push(cell); }
  };
  if (project.layout === 'rectangle' || project.layout === 'isometric' || project.layout === 'isometricZAsY') {
    const coordinates = (point) => project.layout === 'rectangle'
      ? { x: point.x / metrics.cellWidth, y: point.y / metrics.cellHeight }
      : { x: point.x / metrics.cellWidth + point.y / metrics.cellHeight - project.height / 2, y: point.y / metrics.cellHeight - point.x / metrics.cellWidth + project.height / 2 };
    const a = coordinates(start), b = coordinates(end), dx = b.x - a.x, dy = b.y - a.y;
    let first = 0, last = 1;
    for (const [direction, distance] of [[-dx, a.x], [dx, project.width - a.x], [-dy, a.y], [dy, project.height - a.y]]) {
      if (direction === 0) { if (distance < 0) return cells; continue; }
      const time = distance / direction;
      if (direction < 0) first = Math.max(first, time); else last = Math.min(last, time);
      if (first > last) return cells;
    }
    const sx = a.x + dx * first, sy = a.y + dy * first, ex = a.x + dx * last, ey = a.y + dy * last;
    const cellIndex = (value, size) => Math.max(0, Math.min(size - 1, Math.floor(value)));
    let x = cellIndex(sx, project.width), y = cellIndex(sy, project.height);
    const endX = cellIndex(ex, project.width), endY = cellIndex(ey, project.height);
    const stepX = Math.sign(ex - sx), stepY = Math.sign(ey - sy);
    const deltaX = stepX ? Math.abs(1 / (ex - sx)) : Infinity, deltaY = stepY ? Math.abs(1 / (ey - sy)) : Infinity;
    let maxX = stepX > 0 ? (Math.floor(sx) + 1 - sx) * deltaX : stepX < 0 ? (sx - Math.floor(sx)) * deltaX : Infinity;
    let maxY = stepY > 0 ? (Math.floor(sy) + 1 - sy) * deltaY : stepY < 0 ? (sy - Math.floor(sy)) * deltaY : Infinity;
    add({ x, y });
    while (x !== endX || y !== endY) {
      if (Math.abs(maxX - maxY) < 1e-10) {
        add({ x: x + stepX, y }); add({ x, y: y + stepY });
        x += stepX; y += stepY; maxX += deltaX; maxY += deltaY;
      } else if (maxX < maxY) { x += stepX; maxX += deltaX; }
      else { y += stepY; maxY += deltaY; }
      if (x >= 0 && y >= 0 && x < project.width && y < project.height) add({ x, y });
    }
    return cells;
  }
  const dx = end.x - start.x, dy = end.y - start.y;
  const spanX = metrics.stepX || metrics.cellWidth, spanY = metrics.stepY || metrics.cellHeight;
  const samples = Math.max(1, Math.ceil(Math.max(Math.abs(dx / spanX), Math.abs(dy / spanY)) * 4));
  for (let i = 0; i <= samples; i++) {
    const ratio = i / samples, point = { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
    add(gridCellAtPoint(project, metrics, point));
  }
  return cells;
}

export function gridLinesPath(project, metrics) {
  const point = ({ x, y }) => `${Number(x.toFixed(6))},${Number(y.toFixed(6))}`;
  if (project.layout !== 'hexagon') {
    const lines = [];
    for (let x = 0; x <= project.width; x++) lines.push(`M${point(gridPoint(project, metrics, x, 0))}L${point(gridPoint(project, metrics, x, project.height))}`);
    for (let y = 0; y <= project.height; y++) lines.push(`M${point(gridPoint(project, metrics, 0, y))}L${point(gridPoint(project, metrics, project.width, y))}`);
    return lines.join(' ');
  }
  const edges = new Map();
  for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) {
    const polygon = gridCellPolygon(project, metrics, x, y);
    for (let index = 0; index < polygon.length; index++) {
      const from = point(polygon[index]), to = point(polygon[(index + 1) % polygon.length]);
      const key = [from, to].sort().join('|');
      if (!edges.has(key)) edges.set(key, `M${from}L${to}`);
    }
  }
  return [...edges.values()].join(' ');
}
