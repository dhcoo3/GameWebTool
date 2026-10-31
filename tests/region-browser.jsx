import React from 'react';
import { createRoot } from 'react-dom/client';
import MapExpansion from '../src/MapExpansion.jsx';
import { DRAFT_ID } from '../src/map/core.js';
import { readProject, saveProject, migrateProject } from '../src/map/storage.js';
import { exportProject, importProjectZip, exportPsd, exportLayers } from '../src/map/exports.js';
import { readPsd } from 'ag-psd';
import { unzipSync } from 'fflate';

export async function testRegionUi({ p, assets, assert, tick, wait }) {
  await saveProject({ ...p, name: '区域连续绘制验收', regions: [] }, true);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;background:white;font:12px system-ui;line-height:normal'; document.body.append(host);
  const root = createRoot(host), messages = [];
  root.render(<MapExpansion config={{ configured: {}, models: {} }} serverOffline={true} onOpenSettings={() => {}} onNotify={(m) => messages.push(m)}/>);
  const button = (text) => [...host.querySelectorAll('button')].find((e) => e.textContent.trim() === text);
  const click = async (text) => { const b = button(text); assert(b && !b.disabled, `按钮不可用: ${text}`); b.click(); await tick(); };
  const key = async (key, ctrlKey = false, shiftKey = false, target = window) => { target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, ctrlKey, shiftKey, bubbles: true, cancelable: true })); await tick(); };
  let viewport;
  const coords = (x, y) => {
    const values = host.querySelector('.mx-world').style.transform.match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/);
    const b = viewport.getBoundingClientRect(); return { clientX: b.left + Number(values[1]) + x * Number(values[3]), clientY: b.top + Number(values[2]) + y * Number(values[3]) };
  };
  const point = async (x, y) => {
    const position = coords(x, y);
    viewport.dispatchEvent(new PointerEvent('pointerdown', { ...position, pointerId: 1, button: 0, detail: 0, bubbles: true }));
    viewport.dispatchEvent(new PointerEvent('pointerup', { ...position, pointerId: 1, button: 0, bubbles: true })); await tick();
  };
  const count = () => host.querySelectorAll('.mx-region-list > div').length;
  const vertices = () => host.querySelector('.mx-region-actions [role=status]')?.textContent || '';
  const select = async (value) => { const s = host.querySelector('.mx-inspector select'); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); await tick(); };
  try {
    await wait(() => host.querySelector('.mx-selected-meta b') && !button('＋ 新建')?.disabled);
    await click('区域'); await select('occlusion'); await click('多边形'); await click('绘制新区域');
    viewport = host.querySelector('.mx-viewport');
    host.querySelector('[aria-label="重置画布缩放"]').click(); await tick();
    const coordinate = host.querySelector('.mx-grid-coordinates text');
    assert(coordinate && coordinate.textContent === `(${coordinate.dataset.row},${coordinate.dataset.col})`, '格心坐标未显示或编号不一致');
    host.querySelector('[aria-label="隐藏网格"]').click(); await tick();
    assert(!host.querySelector('.mx-grid-coordinates'), '隐藏网格后坐标仍显示');
    host.querySelector('[aria-label="显示网格"]').click(); await tick();
    assert(host.querySelector('.mx-grid-coordinates text'), '重新显示网格后坐标丢失');
    await point(0, 0); await point(35, 0); await point(0, 35); await point(0, 0); await point(0, 0);
    viewport.dispatchEvent(new MouseEvent('dblclick', { ...coords(0, 0), bubbles: true })); await tick();
    assert(count() === 1 && vertices().includes('当前 0'), '起点闭合重复提交或残留点');
    await point(50, 0); await point(85, 0); await point(50, 35); await click('保存当前区域');
    assert(count() === 2 && vertices().includes('当前 0'), '保存按钮未支持连续绘制');
    await point(0, 45); await point(35, 45); await point(0, 80); await key('Enter');
    assert(count() === 3, 'Enter 未保存第三块');
    await point(50, 45); await point(85, 45); await point(50, 80); await point(50, 80);
    viewport.dispatchEvent(new MouseEvent('dblclick', { ...coords(50, 80), bubbles: true })); await tick();
    assert(count() === 4 && vertices().includes('当前 0'), '双击重复提交或残留点');
    await point(100, 10); await point(125, 10); await point(125, 45);
    await key('Backspace'); assert(vertices().includes('当前 2') && count() === 4, 'Backspace 删除了已存区域');
    await key('z', true); assert(vertices().includes('当前 1'), 'Ctrl Z 未撤回点');
    await key('z', true, true); assert(vertices().includes('当前 2'), 'Ctrl Shift Z 未恢复点');
    await click('撤销操作'); await click('撤销操作'); await key('z', true);
    assert(vertices().includes('当前 0') && count() === 4, '撤至零点后影响项目历史');
    await click('重做操作'); assert(vertices().includes('当前 1'), '零点会话无法重做');
    await point(125, 50); assert(button('重做操作').disabled, '新增点未清空重做');
    await click('取消当前绘制'); await click('撤销操作'); assert(count() === 3, '保存区域未作为一次操作撤销');
    await click('重做操作'); assert(count() === 4, '项目区域无法重做');
    await point(0, 0); await point(35, 0); await point(70, 0); await click('保存当前区域');
    assert(vertices().includes('当前 3') && count() === 4 && messages.some((m) => m.includes('面积不能为零')), '无效轮廓被清除');
    const name = [...host.querySelectorAll('input')].find((e) => e.parentElement.textContent.includes('区域名称'));
    await key('Backspace', false, false, name); await key('z', true, false, name);
    assert(vertices().includes('当前 3') && count() === 4, '文本快捷键影响轮廓');
    await key('Escape'); assert(vertices().includes('当前 0') && count() === 4, 'Esc 误删已存区域');
    await point(5, 5); await click('生成'); await click('区域'); assert(vertices().includes('当前 0'), '切换页签残留点');
    await point(5, 5); await click('矩形'); await click('多边形'); assert(vertices().includes('当前 0'), '切换形状残留点');
    await point(5, 5); await click('选择 / 移动'); await click('绘制新区域'); assert(vertices().includes('当前 0'), '选择模式残留点');
    await point(5, 5); await select('top'); assert(vertices().includes('当前 0'), '切换类型残留点'); await select('occlusion');
    await click('保存');
    let saved;
    for (let i = 0; i < 120; i++) { saved = await readProject(DRAFT_ID); if (saved?.regions.length === 4) break; await tick(); }
    assert(saved.regions.length === 4 && new Set(saved.regions.map((r) => r.id)).size === 4, '多个区域保存丢失');
    assert(new Set(saved.regions.map((r) => r.baseline)).size === 2, '不同位置未保存独立基准Y');
    const reopened = await migrateProject(saved, assets); assert(reopened.regions.length === 4, '重开区域丢失');
    const zip = await exportProject(reopened, assets), portable = await importProjectZip(new File([zip], 'regions.zip'), assets);
    assert(portable.regions.length === 4 && portable.regions[2].baseline === saved.regions[2].baseline, 'ZIP 未保留独立轮廓与基准');
    const psd = readPsd(new Uint8Array(await (await exportPsd(reopened, assets)).arrayBuffer()));
    assert(psd.children.filter((r) => r.name.startsWith('遮挡')).length === 4, 'PSD 未导出4个遮挡图层');
    const unity = unzipSync(new Uint8Array(await (await exportLayers(reopened, assets, true)).arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(unity['map.json'])); assert(manifest.regions.length === 4, 'Unity 未导出所有遮挡区');
  } finally { root.unmount(); host.remove(); await tick(); }
}

export async function testRegionTypeUi({ p, assert, tick, wait }) {
  const points = [{ x: 5, y: 5 }, { x: 60, y: 5 }, { x: 60, y: 50 }, { x: 5, y: 50 }];
  const regions = ['occlusion', 'adjustment', 'top'].map((type) => ({ id: type, type, name: `TYPE_${type}`, points, baseline: 50, sortOffset: 0, visible: true }));
  regions.push({ id: 'collision', type: 'collision', name: 'TYPE_collision', cells: [{ x: 0, y: 0 }], points: [], visible: true });
  await saveProject({ ...p, name: '区域类型过滤验收', regions }, true);
  const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;background:white'; document.body.append(host);
  const root = createRoot(host);
  root.render(<MapExpansion config={{ configured: {}, models: {} }} serverOffline={true} onOpenSettings={() => {}} onNotify={() => {}}/>);
  const button = (text) => [...host.querySelectorAll('button')].find((e) => e.textContent.trim() === text);
  try {
    await wait(() => host.querySelector('.mx-selected-meta b') && !button('＋ 新建')?.disabled);
    button('区域').click(); await tick();
    for (const type of ['occlusion', 'collision', 'adjustment', 'top', 'occlusion']) {
      const select = host.querySelector('.mx-inspector select'); select.value = type; select.dispatchEvent(new Event('change', { bubbles: true })); await tick();
      const rows = [...host.querySelectorAll('.mx-region-list > div')], expectedName = type === 'collision' ? '碰撞格子' : `TYPE_${type}`;
      assert(rows.length === 1 && rows[0].textContent.includes(expectedName), `列表混入其他类型: ${type}`);
      assert(!host.querySelector('.mx-region-details'), '切换类型保留了旧属性面板');
      rows[0].querySelector('button').click(); await tick();
      assert(host.querySelector('.mx-region-details input').value === expectedName, '选中属性与当前类型不一致');
      if (type !== 'collision') {
        assert(!host.querySelector('.mx-inspector-content').textContent.includes('碰撞格子'), '非碰撞面板混入碰撞数据');
        assert(host.querySelectorAll('.mx-collision-cell').length === 1, '编辑其他类型时丢失碰撞参考标记');
        assert(host.querySelectorAll('.mx-regions-svg > g > polygon').length === 3, '画布未同时显示所有几何区域标记');
      }
    }
  } finally { root.unmount(); host.remove(); await tick(); }
}
