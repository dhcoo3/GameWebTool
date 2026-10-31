import test from 'node:test';
import assert from 'node:assert/strict';
import { batchTargets, collectAssetIds, DIRECTIONS, mapBounds, mapGridGeometry, mapWorkspaceBounds, newProject, normalizeProject, pointInPolygon, readyTasks, reflow, splitRect, steps, tileRect } from '../src/map/core.js';
import { MAP_CAPABILITIES, validateMapRequest } from '../server/map.js';
import { gridCellAtPoint, gridCellPolygon, gridLinesPath, gridMetrics, gridPoint, normalizeGrid, traceGridCells } from '../src/gridGeometry.js';
import { mapGenerationPrompts } from '../src/map/prompts.js';

const project = () => ({ ...newProject(), tileWidth: 320, tileHeight: 180, tiles: [{ id: 'base', x: 0, y: 0, originalId: 'source' }] });
test('地图网格兼容旧项目并在项目往返后保留全部设置', () => {
  const old = { ...project() }; delete old.grid;
  assert.deepEqual(normalizeProject(old).grid, normalizeGrid());
  const grid = { width: 24, height: 16, cellWidthPx: 100, cellHeightPx: 50, layout: 'hexagon', hexOrientation: 'flat', visible: false };
  const restored = normalizeProject(JSON.parse(JSON.stringify({ ...project(), grid })));
  assert.deepEqual(restored.grid, grid);
  const original = project(), other = newProject(); original.grid.width = 48;
  assert.equal(other.grid.width, 32);
  assert.deepEqual(normalizeGrid({ width: -10, height: 200, cellWidthPx: Infinity, cellHeightPx: 0, layout: 'unknown' }), { ...normalizeGrid(), width: 4, height: 64, cellHeightPx: 1 });
});
test('Cell 像素比例实际改变矩形和等距网格高度', () => {
  for (const layout of ['rectangle', 'isometric', 'isometricZAsY']) {
    const square = normalizeGrid({ layout }), flat = { ...square, cellHeightPx: 50 };
    const a = gridMetrics(square, square.cellWidthPx), b = gridMetrics(flat, flat.cellWidthPx);
    assert.equal(a.boardWidth, b.boardWidth);
    assert.equal(a.boardHeight / 2, b.boardHeight);
    const polygon = gridCellPolygon(flat, b, 0, 0);
    assert.equal(Math.max(...polygon.map((p) => p.x)) - Math.min(...polygon.map((p) => p.x)), 100);
    assert.equal(Math.max(...polygon.map((p) => p.y)) - Math.min(...polygon.map((p) => p.y)), 50);
    assert.equal(gridLinesPath(flat, b).split('M').length - 1, flat.width + flat.height + 2);
  }
});
test('六边形方向切换改变轮廓和排列，最大网格保持有限坐标', () => {
  const pointy = normalizeGrid({ layout: 'hexagon', width: 4, height: 6 });
  const flat = { ...pointy, hexOrientation: 'flat' };
  const a = gridMetrics(pointy, 100), b = gridMetrics(flat, 100);
  assert.notEqual(a.boardWidth, b.boardWidth);
  assert.notEqual(a.boardHeight, b.boardHeight);
  assert.notDeepEqual(gridCellPolygon(pointy, a, 0, 0), gridCellPolygon(flat, b, 0, 0));
  for (const hexOrientation of ['pointy', 'flat']) {
    const grid = normalizeGrid({ layout: 'hexagon', hexOrientation, width: 64, height: 64, cellWidthPx: 4096, cellHeightPx: 4096 });
    const metrics = gridMetrics(grid, grid.cellWidthPx), path = gridLinesPath(grid, metrics);
    assert.ok(Number.isFinite(metrics.boardWidth) && Number.isFinite(metrics.boardHeight));
    assert.ok(path.length > 0 && !/NaN|Infinity/.test(path));
  }
});
test('查看网格独立于地图图块尺寸与拼接重叠', () => {
  const p = project(), before = tileRect(p, p.tiles[0]);
  const configured = { ...p, grid: normalizeGrid({ width: 48, height: 12, cellWidthPx: 50, layout: 'isometric' }) };
  assert.deepEqual(tileRect(configured, configured.tiles[0]), before);
  const reflowed = reflow(configured, 25, 20);
  assert.deepEqual(reflowed.grid, configured.grid);
  assert.deepEqual(reflowed.tiles[0].originalId, p.tiles[0].originalId);
});
test('不同网格布局和 Cell 大小始终与主图像素中心对齐', () => {
  const p = { ...project(), tileWidth: 1672, tileHeight: 941, tiles: [{ id: 'base', kind: 'base', x: 0, y: 0, width: 1672, height: 941 }] };
  for (const layout of ['rectangle', 'isometric', 'isometricZAsY', 'hexagon']) for (const hexOrientation of ['pointy', 'flat']) {
    for (const options of [{}, { width: 24, height: 16, cellWidthPx: 50, cellHeightPx: 25 }]) {
      const value = { ...p, grid: normalizeGrid({ layout, hexOrientation, cellHeightPx: 50, ...options }) };
      const geometry = mapGridGeometry(value);
      assert.ok(Math.abs(geometry.x + geometry.width / 2 - 836) < 1e-8);
      assert.ok(Math.abs(geometry.y + geometry.height / 2 - 470.5) < 1e-8);
      assert.deepEqual(mapGridGeometry(normalizeProject(JSON.parse(JSON.stringify(value)))), geometry);
    }
  }
  p.grid = normalizeGrid({ layout: 'isometricZAsY', cellHeightPx: 50 });
  const geometry = mapGridGeometry(p);
  assert.equal(geometry.x, -764); assert.equal(geometry.y, -329.5);
  assert.deepEqual(mapWorkspaceBounds(p), { x: -764, y: -329.5, width: 3200, height: 1600 });
  assert.deepEqual(mapWorkspaceBounds({ ...p, grid: { ...p.grid, visible: false } }), mapBounds(p));
});
test('碰撞格命中与拖动采样覆盖矩形、等距和六边形网格路径', () => {
  for (const layout of ['rectangle', 'isometric', 'isometricZAsY', 'hexagon']) for (const hexOrientation of ['pointy', 'flat']) {
    const grid = normalizeGrid({ layout, hexOrientation, width: 8, height: 8, cellWidthPx: 80, cellHeightPx: 40 });
    const metrics = gridMetrics(grid, grid.cellWidthPx), origin = { x: -125, y: 61 };
    const centerOf = (x, y) => { const polygon = gridCellPolygon(grid, metrics, x, y); return polygon.reduce((sum, point) => ({ x: sum.x + point.x / polygon.length, y: sum.y + point.y / polygon.length }), { x: 0, y: 0 }); };
    for (const [x, y] of [[0, 0], [2, 3], [7, 7]]) {
      const center = layout === 'hexagon' ? centerOf(x, y) : gridPoint(grid, metrics, x + .5, y + .5);
      assert.deepEqual(gridCellAtPoint(grid, metrics, center), { x, y }, `${layout}/${hexOrientation} 格心命中错误：${x},${y}`);
    }
    const start = layout === 'hexagon' ? centerOf(1, 3) : gridPoint(grid, metrics, 1.5, 3.5), end = layout === 'hexagon' ? centerOf(6, 3) : gridPoint(grid, metrics, 6.5, 3.5);
    const traced = new Set(traceGridCells({ x: origin.x + start.x, y: origin.y + start.y }, { x: origin.x + end.x, y: origin.y + end.y }, grid, metrics, origin).map((cell) => `${cell.x},${cell.y}`));
    for (let x = 1; x <= 6; x++) assert.ok(traced.has(`${x},3`), `${layout}/${hexOrientation} 快速拖动漏过 ${x},3`);
  }
  const grid = normalizeGrid({ layout: 'rectangle', width: 8, height: 8, cellWidthPx: 80, cellHeightPx: 40 }), metrics = gridMetrics(grid, grid.cellWidthPx);
  assert.deepEqual(traceGridCells({ x: -100, y: -100 }, { x: -10, y: -10 }, grid, metrics), []);
  const through = traceGridCells({ x: -20, y: 20 }, { x: 700, y: 20 }, grid, metrics);
  assert.deepEqual(through.map((cell) => cell.x), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(through.every((cell) => cell.x >= 0 && cell.y >= 0 && cell.x < grid.width && cell.y < grid.height));
});
test('向负坐标扩图或切换图块不会移动主图的网格锚点和区域坐标', () => {
  const p = project(); p.tiles[0].kind = 'base';
  p.regions = [{ type: 'collision', points: [{ x: 40, y: 50 }, { x: 90, y: 50 }, { x: 90, y: 80 }], baseline: 80 }];
  const geometry = mapGridGeometry(p), regions = JSON.stringify(p.regions);
  const expanded = { ...p, tiles: [{ id: 'west', x: -1, y: -1 }, ...p.tiles, { id: 'east', x: 1, y: 1 }] };
  assert.deepEqual(mapGridGeometry(expanded), geometry);
  assert.equal(JSON.stringify(expanded.regions), regions);
  const withoutMain = { ...expanded, tiles: expanded.tiles.filter((tile) => tile.kind !== 'base') };
  assert.deepEqual(mapGridGeometry(withoutMain), geometry);
});
test('八方向、非正方形和负坐标使用独立重叠距离', () => {
  const p = project(); assert.deepEqual(steps(p), { x: 272, y: 153 });
  for (const d of DIRECTIONS) { const r = tileRect(p, { x: d.dx, y: d.dy }); assert.equal(r.x, d.dx * 272); assert.equal(r.y, d.dy * 153); assert.equal(r.width, 320); assert.equal(r.height, 180); }
  const p2 = { ...p, tiles: [...p.tiles, { x: -1, y: -1 }, { x: 1, y: 1 }] };
  assert.deepEqual(mapBounds(p2), { x: -272, y: -153, width: 864, height: 486 });
});
test('重叠重排与标注使用一致的坐标变换', () => {
  const p = project(); p.overlapX = p.overlapY = 0; p.tiles.push({ x: 1, y: 1 }); p.regions = [{ points: [{ x: 340, y: 200 }], baseline: 200 }, { points: [{ x: 200, y: 120 }], baseline: 120 }];
  const next = reflow(p, 25, 10); assert.equal(next.tiles[1].px, 240); assert.equal(next.tiles[1].py, 162); assert.deepEqual(next.regions[0].points[0], { x: 260, y: 182 });
  assert.equal(next.regions[0].baseline, 182); assert.deepEqual(next.regions[1].points[0], { x: 200, y: 120 }); assert.equal(p.tiles[1].px, undefined);
});
test('非整除细分无缝覆盖所有像素且不越界', () => {
  for (const n of [1, 2, 3]) {
    const rects = splitRect(101, 67, n), hits = new Uint8Array(101 * 67);
    for (const r of rects) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) hits[y * 101 + x]++;
    assert.equal(rects.length, n * n); assert.ok(hits.every((n) => n === 1));
  }
});
test('自动队列只补空位，按邻接关系推进', () => {
  const p = project(), tasks = batchTargets(p, p.tiles[0], 3, 3);
  assert.equal(tasks.length, 8); assert.ok(!tasks.some((t) => !t.x && !t.y)); assert.equal(readyTasks(p, tasks).length, 8);
  const distant = [{ x: 4, y: 4, status: 'waiting' }]; assert.equal(readyTasks(p, distant).length, 0);
  assert.equal(batchTargets(p, p.tiles[0], 100, 100).length, 80);
});
test('恢复草稿不会自动继续发送生成请求，引用素材包括分段和批次基线', () => {
  const p = normalizeProject({ ...project(), queue: { status: 'running', tasks: [{ status: 'running', completedParts: [{ assetId: 'part' }] }], baseline: { tiles: [{ originalId: 'old' }] } }, work: { status: 'running' } });
  assert.equal(p.queue.status, 'paused'); assert.equal(p.queue.tasks[0].status, 'waiting'); assert.equal(p.work.status, 'paused');
  assert.deepEqual(new Set(collectAssetIds(p)), new Set(['source', 'part', 'old']));
});
test('区域点选支持凹多边形与负坐标', () => {
  const pts = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 10 }];
  assert.ok(pointInPolygon({ x: -5, y: 5 }, pts)); assert.ok(!pointInPolygon({ x: 5, y: 5 }, pts));
});
test('地图 API 校验操作、尺寸、分辨率和四个服务能力', () => {
  for (const provider of Object.keys(MAP_CAPABILITIES)) {
    const result = validateMapRequest({ provider, operation: 'expand', imageBase64: 'a', width: 128, height: 64, prompt: 'forest', markedGuide: true });
    assert.match(result.prompt, /MAGENTA/); assert.equal(result.provider, provider); assert.equal(result.resolution, 'native');
  }
  const matte = validateMapRequest({ provider: 'openai', operation: 'matte', imageBase64: 'a', width: 128, height: 64, prompt: 'forest', negativePrompt: 'black' }); assert.equal(matte.negativePrompt, ''); assert.ok(!matte.prompt.includes('forest'));
  for (const patch of [{ operation: 'unknown' }, { width: -1 }, { height: Infinity }, { imageBase64: '' }, { provider: 'other' }, { resolution: '8K' }]) assert.throws(() => validateMapRequest({ provider: 'gemini', operation: 'expand', imageBase64: 'a', width: 128, height: 128, ...patch }));
});
test('所有地图服务的初始图请求都明确要求矩形满幅并只把等距作为视角', () => {
  for (const provider of Object.keys(MAP_CAPABILITIES)) for (const imageBase64 of ['', 'reference']) {
    const result = validateMapRequest({ provider, operation: 'seed', imageBase64, width: 3840, height: 2160, prompt: '暗黑幻想森林，45°等距视角', negativePrompt: '人物，文字' });
    assert.match(result.prompt, /rectangular crop of a continuous game world/);
    assert.match(result.prompt, /ALL FOUR CORNERS/);
    assert.match(result.prompt, /camera angle ONLY/);
    assert.match(result.prompt, /ignore any isolated outline/);
    assert.match(result.prompt, /暗黑幻想森林/);
    assert.match(result.negativePrompt, /diamond-shaped map outline/);
    assert.match(result.negativePrompt, /人物/);
    assert.ok(!result.prompt.includes('opaque pixels are protected'));
  }
});
test('浏览器和服务端重复附加构图规则不会重复或截断用户描述', () => {
  const description = 'a'.repeat(7990) + 'end-marker';
  const first = mapGenerationPrompts('seed', description, '人物，文字');
  assert.deepEqual(mapGenerationPrompts('seed', first.prompt, first.negativePrompt), first);
  const result = validateMapRequest({ provider: 'kling', operation: 'seed', width: 128, height: 128, ...first });
  assert.equal(result.prompt.split('Map framing requirement:').length - 1, 1);
  assert.ok(result.prompt.endsWith('end-marker'));
});
test('扩图仍保护既有像素，分层蒙版和局部重绘不附加满幅构图规则', () => {
  const expanded = validateMapRequest({ provider: 'gemini', operation: 'expand', width: 128, height: 128, imageBase64: 'a', prompt: 'forest', markedGuide: true });
  assert.match(expanded.prompt, /rectangular editable area/);
  assert.match(expanded.prompt, /Preserve ALL protected content exactly/);
  assert.match(expanded.prompt, /MAGENTA/);
  for (const operation of ['matte', 'ground', 'retouch']) {
    const result = validateMapRequest({ provider: 'gemini', operation, width: 128, height: 128, imageBase64: 'a', prompt: 'forest' });
    assert.ok(!result.prompt.includes('Map framing requirement:'));
  }
});

test('项目全局规则默认留空，旧项目兼容并保留项目与队列快照', () => {
  const old = project(); delete old.globalPositivePrompt; delete old.globalNegativePrompt;
  assert.equal(normalizeProject(old).globalPositivePrompt, '');
  assert.equal(normalizeProject(old).globalNegativePrompt, '');
  const rules = { globalPositivePrompt: '低像素与统一镜头', globalNegativePrompt: '平滑渐变' };
  const restored = normalizeProject(JSON.parse(JSON.stringify({ ...old, ...rules, queue: { status: 'running', settings: rules, tasks: [] } })));
  assert.equal(restored.globalPositivePrompt, rules.globalPositivePrompt);
  assert.equal(restored.globalNegativePrompt, rules.globalNegativePrompt);
  assert.deepEqual(restored.queue.settings, rules);
  assert.equal(restored.queue.status, 'paused');
});
test('四服务的初始图、扩图、重绘合并全局规则一次，分层与蒙版不混入规则', () => {
  for (const provider of Object.keys(MAP_CAPABILITIES)) for (const operation of ['seed', 'expand', 'retouch', 'ground', 'matte', 'objects']) {
    if (operation === 'objects' && provider === 'qwen') continue;
    const rules = { globalPositivePrompt: 'GLOBAL_STYLE_SENTINEL', globalNegativePrompt: 'GLOBAL_AVOID_SENTINEL' };
    const local = mapGenerationPrompts(operation, 'LOCAL_SCENE', 'LOCAL_AVOID');
    const result = validateMapRequest({ provider, operation, width: 128, height: 128, imageBase64: 'mock', ...local, ...rules });
    const map = ['seed', 'expand', 'retouch'].includes(operation);
    assert.equal(result.prompt.split(rules.globalPositivePrompt).length - 1, map ? 1 : 0);
    assert.equal(result.negativePrompt.split(rules.globalNegativePrompt).length - 1, map ? 1 : 0);
    if (map) {
      assert.equal(result.mapPrompt.prompt.split(rules.globalPositivePrompt).length - 1, 1);
      assert.match(result.prompt, /LOCAL_SCENE/);
    }
  }
});

test('区域绘制逐点撤销重做，零点会话保留，新点清空重做', async () => {
  const { emptyPolygonDraft, polygonDraftAction } = await import('../src/map/regionDrawing.js');
  let draft = emptyPolygonDraft();
  const a = { x: 1, y: 2 }, b = { x: 3, y: 4 };
  draft = polygonDraftAction(draft, 'add', a); draft = polygonDraftAction(draft, 'add', b);
  draft = polygonDraftAction(draft, 'undo'); assert.deepEqual(draft.points, [a]);
  draft = polygonDraftAction(draft, 'undo'); assert.equal(draft.active, true); assert.equal(draft.points.length, 0);
  assert.deepEqual(polygonDraftAction(draft, 'undo'), draft);
  draft = polygonDraftAction(draft, 'redo'); assert.deepEqual(draft.points, [a]);
  draft = polygonDraftAction(draft, 'add', { x: 5, y: 6 }); assert.deepEqual(draft.redo, []);
  assert.deepEqual(polygonDraftAction(draft, 'cancel'), emptyPolygonDraft());
});
test('起点闭合用屏幕10像素判定，几何校验拒绝重复和零面积轮廓', async () => {
  const { nearPolygonStart, regionPolygon } = await import('../src/map/regionDrawing.js');
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  for (const zoom of [.001, .25, 1, 3]) {
    assert.equal(nearPolygonStart(points, { x: 9 / zoom, y: 0 }, zoom), true);
    assert.equal(nearPolygonStart(points, { x: 11 / zoom, y: 0 }, zoom), false);
  }
  assert.equal(nearPolygonStart(points.slice(0, 2), points[0], 1), false);
  assert.deepEqual(regionPolygon([...points, points[2], points[0]]), points);
  assert.equal(regionPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]), null);
  assert.equal(regionPolygon([{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 2, y: 3 }]), null);
  assert.equal(regionPolygon([points[0], points[1], points[0]]), null);
});

test('格子坐标位于格心，等距底尖为(0,0)，所有布局与导出地址一致', async () => {
  const { gridCoordinateLabels, collisionCellAddress } = await import('../src/map/core.js');
  for (const layout of ['rectangle', 'isometric', 'isometricZAsY', 'hexagon']) for (const hexOrientation of ['point', 'flat']) {
    const grid = normalizeGrid({ width: 4, height: 6, cellWidthPx: 64, cellHeightPx: 32, layout, hexOrientation });
    const labels = gridCoordinateLabels(grid), metrics = gridMetrics(grid, grid.cellWidthPx);
    assert.equal(labels.length, 24);
    for (const label of labels) {
      const [x, y] = label.key.split(',').map(Number), polygon = gridCellPolygon(grid, metrics, x, y), address = collisionCellAddress(grid, x, y);
      assert.equal(label.row, address.row); assert.equal(label.col, address.col);
      assert.ok(pointInPolygon({ x: label.x, y: label.y }, polygon));
    }
    const origin = labels.find((p) => p.row === 0 && p.col === 0);
    assert.equal(origin.key, layout.startsWith('isometric') ? '3,5' : '0,0');
  }
});
