import { zipSync, unzipSync, strToU8 } from 'fflate';
import { assetFor, collisionCellAddress, FORMAT, mapBounds, mapGridGeometry, tileRect } from './core.js';
import { normalizeGrid } from '../gridGeometry.js';
import { canvas, canvasBlob, renderRect, renderRegion } from './images.js';
import { portableFiles, importPortable } from './storage.js';
import rootCode from '../../unity/Runtime/FactoryMapRoot.cs?raw';
import sortCode from '../../unity/Runtime/FactoryMapSort.cs?raw';
import zoneCode from '../../unity/Runtime/FactoryMapZone.cs?raw';
import importerCode from '../../unity/Editor/FactoryMapImporter.cs?raw';

export const safeName = (s) => String(s || '地图').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
export function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export const packZip = (files) => new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
export async function importProjectZip(file, assets) {
  if (file.size > 512 * 1024 * 1024) throw new Error('项目 ZIP 超过 512 MB，请缩小素材后再导入。');
  let expanded = 0;
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => {
    const allowed = f.name === 'project.json' || /^assets\/[\w-]+\.png$/.test(f.name);
    if (!allowed) return false;
    expanded += f.originalSize;
    if (f.originalSize > 128 * 1024 * 1024 || expanded > 512 * 1024 * 1024) throw new Error('项目解压内容过大，请减少项目素材后重试。');
    return true;
  } });
  return importPortable(files, assets);
}
export async function exportProject(p, assets) { return packZip(await portableFiles(p, assets)); }
async function png(c) { return new Uint8Array(await (await canvasBlob(c)).arrayBuffer()); }
async function exportParts(p, assets) {
  const files = {}, images = [], previous = [];
  for (const tile of p.tiles) {
    const rect = tileRect(p, tile);
    for (const layer of ['ground', 'objects']) {
      if (!assetFor(tile, layer) || p.visibility[layer] === false) continue;
      const c = await renderRect(p, assets, rect, layer, { cutRegions: layer === 'objects' }), ctx = c.getContext('2d');
      for (const r of previous) ctx.clearRect(r.x - rect.x, r.y - rect.y, r.width, r.height);
      const file = `layers/${layer}/${tile.x}_${tile.y}.png`; files[file] = await png(c);
      images.push({ file, name: `${layer === 'ground' ? '地面' : '物件'} ${tile.x},${tile.y}`, kind: layer, ...rect, baseline: rect.y + rect.height, sortOffset: 0 });
    }
    files[`tiles/${tile.x}_${tile.y}.png`] = new Uint8Array(await (await assets.get(tile.originalId)).arrayBuffer()); previous.push(rect);
  }
  if (p.visibility.objects) for (const region of p.regions.filter((r) => ['occlusion', 'top'].includes(r.type) && r.visible !== false)) {
    const rendered = await renderRegion(p, assets, region), file = `regions/${region.id}.png`; files[file] = await png(rendered.canvas);
    images.push({ file, name: region.name, kind: region.type, ...rendered.rect, baseline: region.baseline, sortOffset: region.sortOffset || 0 });
  }
  const bounds = mapBounds(p);
  const grid = normalizeGrid(p.grid), gridGeometry = mapGridGeometry(p);
  const collisionGrid = {
    coordinateSystem: 'grid-row-column-zero-based', indexOrigin: ['isometric', 'isometricZAsY'].includes(grid.layout) ? 'bottom-tip' : 'top-left',
    layout: grid.layout, columns: grid.width, rows: grid.height, cellWidthPx: grid.cellWidthPx, cellHeightPx: grid.cellHeightPx, hexOrientation: grid.hexOrientation,
    centerX: gridGeometry.center.x, centerY: gridGeometry.center.y,
    cells: p.regions.filter((region) => region.type === 'collision').flatMap((region) => region.cells || []).map(({ x, y }) => collisionCellAddress(grid, x, y)).sort((a, b) => a.row - b.row || a.col - b.col),
  };
  const manifest = { format: FORMAT, version: 2, name: p.name, coordinateSystem: 'pixel-top-left-y-down', pixelsPerUnit: p.pixelsPerUnit || 100,
    originX: bounds.x, originY: bounds.y, width: bounds.width, height: bounds.height,
    tileWidth: p.tileWidth, tileHeight: p.tileHeight, overlapX: p.overlapX, overlapY: p.overlapY, images, collisionGrid,
    tiles: p.tiles.map((t) => { const r = tileRect(p, t); return { id: t.id, col: t.x, row: t.y, x: r.x, y: r.y, width: r.width, height: r.height, file: `tiles/${t.x}_${t.y}.png` }; }), regions: p.regions.filter((region) => region.type !== 'collision') };
  files['map.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return { files, manifest };
}
export async function exportPng(p, assets, layer = 'composite') { return canvasBlob(await renderRect(p, assets, mapBounds(p), layer)); }
export async function exportLayers(p, assets, unity = false) {
  const { files } = await exportParts(p, assets);
  if (unity) {
    files['Unity/Runtime/FactoryMapRoot.cs'] = strToU8(rootCode);
    files['Unity/Runtime/FactoryMapSort.cs'] = strToU8(sortCode);
    files['Unity/Runtime/FactoryMapZone.cs'] = strToU8(zoneCode);
    files['Unity/Editor/FactoryMapImporter.cs'] = strToU8(importerCode);
    files['使用说明.txt'] = strToU8('生产工厂 · Unity 2D 地图资源\n\n兼容 Unity / 团结 2022.3。\n1. 解压整个 ZIP。把整套 Unity 文件夹放到工程 Assets/Unity，目录必须为 Assets/Unity/Runtime 和 Assets/Unity/Editor。Runtime 用于运行时，不能放在任何 Editor 文件夹下，也不能归入仅编辑器使用的程序集。不要放成 Assets/Editor/Unity。若之前放错，请移动已有 Unity 文件夹，不要保留两份同名脚本。\n2. 等待脚本编译，打开 Tools > 生产工厂 > 导入 2D 地图，选择本资源包的 map.json。\n3. 在 Assets/GeneratedMaps 下找到生成的 Prefab，拖入场景。再次导入会更新同名 Prefab。\n4. 给角色 SpriteRenderer 或 SortingGroup 所在对象添加 FactoryMapSort，启用 Follow Transform，并指定地图 Root 和 Feet（脚底）。\n5. 碰撞格按 map.json 的 collisionGrid.cells 行列坐标导入为 PolygonCollider2D；角色需自行配置 Rigidbody2D / Collider2D。排序调节区通过脚底位置检测，不要求角色触发器事件。\n\n坐标：图像左上为像素原点，Y 向下，默认 100 Pixels Per Unit。Unity 使用 XY 平面，Y 向上。collisionGrid.cells 使用从 0 开始的 row / col；等距网格从图示底尖 (0,0) 向上编号，矩形和六边形网格从左上角编号。地面固定最下层，最上层固定前景，其余按标记脚底 Y 排序。未分区的物件块按整块脚底排序；需要角色穿行遮挡的建筑应在网页上单独标记遮挡区。分层和标注仍需人工检查。\n无已接纳地面层时，完整原图作为底图保留，不挖空遮挡区域；独立物件叠加参与排序。这适用于静态地图遮挡；隐藏或移动物件时，底图仍保留该物件，需要纯地面层才能移除。\n像素滤镜默认为 Point，可在 Unity Texture Importer 内调整。\n');
  }
  return packZip(files);
}
export async function exportPsd(p, assets) {
  const bounds = mapBounds(p);
  const regionPixels = p.regions.filter((r) => ['occlusion', 'top'].includes(r.type)).reduce((sum, r) => { const xs = r.points.map((p) => p.x), ys = r.points.map((p) => p.y); return sum + (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)); }, 0);
  if (bounds.width * bounds.height > 32_000_000 || bounds.width * bounds.height * 2 + regionPixels > 64_000_000) throw new Error('PSD 图层总像素超过安全范围，请使用分层 PNG ZIP。');
  const { writePsdUint8Array } = await import('ag-psd');
  const children = [];
  for (const layer of ['ground', 'objects']) {
    const c = await renderRect(p, assets, bounds, layer, { cutRegions: layer === 'objects' });
    children.push({ name: layer === 'ground' ? '地面' : '物件', canvas: c, hidden: !p.visibility[layer], left: 0, top: 0 });
  }
  for (const r of p.regions.filter((r) => ['occlusion', 'top'].includes(r.type))) {
    const output = await renderRegion(p, assets, r); children.push({ name: r.name, canvas: output.canvas, left: output.rect.x - bounds.x, top: output.rect.y - bounds.y, hidden: r.visible === false || !p.visibility.objects });
  }
  // Composite must reflect the PSD's visual layers, including extracted occluders.
  const composite = canvas(bounds.width, bounds.height), cc = composite.getContext('2d');
  for (const layer of children) if (!layer.hidden) cc.drawImage(layer.canvas, layer.left, layer.top);
  return new Blob([writePsdUint8Array({ width: bounds.width, height: bounds.height, canvas: composite, children: [...children].reverse() })], { type: 'image/vnd.adobe.photoshop' });
}
export { exportParts };
