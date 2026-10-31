import { newProject, mapBounds } from '../src/map/core.js';
import { canvas, storeCanvas, loadImage, renderRect } from '../src/map/images.js';
import { exportParts, exportLayers, exportPsd, exportPng } from '../src/map/exports.js';
import { unzipSync } from 'fflate';
import { readPsd } from 'ag-psd';

export async function testExportBackground({ assets, assert }) {
  const ground = canvas(64, 64), gc = ground.getContext('2d'); gc.fillStyle = '#574332'; gc.fillRect(0, 0, 64, 64); gc.clearRect(0, 0, 2, 2);
  const objects = canvas(64, 64), oc = objects.getContext('2d'); oc.fillStyle = '#88712b'; oc.fillRect(8, 8, 28, 28); oc.clearRect(16, 16, 6, 6); oc.fillRect(46, 8, 12, 12);
  const original = canvas(64, 64); original.getContext('2d').drawImage(ground, 0, 0); original.getContext('2d').drawImage(objects, 0, 0);
  const originalId = await storeCanvas(original, assets), objectsId = await storeCanvas(objects, assets), groundId = await storeCanvas(ground, assets);
  const polygon = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const base = { ...newProject(), tileWidth: 64, tileHeight: 64, tiles: [{ id: 'base', x: 0, y: 0, px: 0, py: 0, width: 64, height: 64, originalId }], regions: [
    { id: 'tree', name: '树木遮挡', type: 'occlusion', points: polygon(6, 6, 32, 32), baseline: 38, sortOffset: 2, visible: true },
    { id: 'top', name: '固定前景', type: 'top', points: polygon(44, 6, 16, 16), baseline: 22, sortOffset: 0, visible: true },
    { id: 'hidden', name: '隐藏区域', type: 'occlusion', points: polygon(30, 44, 10, 10), baseline: 54, sortOffset: 0, visible: false },
    { id: 'adjustment', name: '排序调节', type: 'adjustment', points: polygon(2, 40, 10, 10), baseline: 50, sortOffset: 20, visible: true },
  ] };
  const pixels = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const same = (a, b, label) => { const x = pixels(a), y = pixels(b); assert(x.length === y.length && x.every((v, i) => v === y[i]), `${label}; first diff ${Array.from(x).findIndex((v, i) => v !== y[i])}`); };
  const decode = async (bytes) => { const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' })); try { return await loadImage(url); } finally { URL.revokeObjectURL(url); } };
  const scenarios = [
    ['只有原图', {}], ['原图和透明物件', { objectsId }], ['完整分层', { objectsId, groundId }], ['未接纳地面预览', { objectsId, layerDraft: { groundId } }],
  ];
  for (const [name, extra] of scenarios) {
    const p = { ...base, tiles: [{ ...base.tiles[0], ...extra }] };
    for (const visibility of [{ ground: true, objects: true }, { ground: true, objects: false }, { ground: false, objects: true }]) {
      p.visibility = visibility;
      const bounds = mapBounds(p), expected = await renderRect(p, assets, bounds), flatExpected = await renderRect(p, assets, bounds), exported = await exportParts(p, assets);
      // Existing layer exports can expose original-image region crops even when
      // the background is hidden and no separate object layer exists.
      if (!extra.objectsId && !visibility.ground && visibility.objects) {
        const ec = expected.getContext('2d');
        for (const region of base.regions.filter((r) => ['occlusion', 'top'].includes(r.type) && r.visible)) {
          ec.save(); ec.beginPath(); region.points.forEach((q, i) => i ? ec.lineTo(q.x, q.y) : ec.moveTo(q.x, q.y)); ec.closePath(); ec.clip(); ec.drawImage(original, 0, 0); ec.restore();
        }
      }
      const combined = canvas(bounds.width, bounds.height), cc = combined.getContext('2d');
      for (const item of exported.manifest.images) cc.drawImage(await decode(exported.files[item.file]), item.x - bounds.x, item.y - bounds.y);
      same(combined, expected, `${name} ${JSON.stringify(visibility)}: PNG 图层重组改变画面`);
      if (visibility.ground) {
        const baseImage = exported.manifest.images.find((i) => i.kind === 'ground'), backing = canvas(64, 64); backing.getContext('2d').drawImage(await decode(exported.files[baseImage.file]), 0, 0);
        same(backing, extra.groundId ? ground : original, `${name}: 底图被挖空`);
        assert(pixels(combined)[(18 * 64 + 18) * 4 + 3] === 255, `${name}: 树冠缝隙没有底图`);
      }
      assert(pixels(combined)[3] === 0, `${name}: 原本透明的角落被填充`);
      const psd = readPsd(new Uint8Array(await (await exportPsd(p, assets)).arrayBuffer())); same(psd.canvas, expected, `${name}: PSD 合成不一致`);
      const merged = canvas(bounds.width, bounds.height); merged.getContext('2d').drawImage(await decode(new Uint8Array(await (await exportPng(p, assets)).arrayBuffer())), 0, 0); same(merged, flatExpected, `${name}: PNG 合成不一致`);
      assert(!exported.manifest.images.some((i) => i.name === '隐藏区域'), '隐藏区域意外导出');
      assert(exported.manifest.regions.find((r) => r.id === 'adjustment').sortOffset === 20, '排序调节数据改变');
    }
  }
  const mixed = { ...base, tiles: [{ ...base.tiles[0], objectsId }, { ...base.tiles[0], id: 'second', x: 1, px: 56, groundId, objectsId }], regions: [...base.regions,
    { id: 'cross', name: '跨图块区域', type: 'occlusion', points: polygon(55, 10, 28, 28), baseline: 38, sortOffset: 4, visible: true }] };
  const bounds = mapBounds(mixed), expected = await renderRect(mixed, assets, bounds);
  for (const unity of [false, true]) {
    const files = unzipSync(new Uint8Array(await (await exportLayers(mixed, assets, unity)).arrayBuffer())), manifest = JSON.parse(new TextDecoder().decode(files['map.json']));
    const combined = canvas(bounds.width, bounds.height), ctx = combined.getContext('2d');
    for (const image of manifest.images) ctx.drawImage(await decode(files[image.file]), image.x - bounds.x, image.y - bounds.y);
    same(combined, expected, `混合地面状态${unity ? 'Unity' : 'PNG'}重组不一致`);
    assert(manifest.images.find((r) => r.name === '跨图块区域').baseline === 38, '区域排序基准改变');
    if (unity) assert(files['Unity/Editor/FactoryMapImporter.cs'], 'Unity 导入器缺失');
  }
  const psd = readPsd(new Uint8Array(await (await exportPsd(mixed, assets)).arrayBuffer())); same(psd.canvas, expected, '混合地面状态PSD重组不一致');
}
