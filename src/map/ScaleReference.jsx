import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { advanceCharacter, canStandAt, characterPlacement, normalizeScaleReference } from './scale.js';
import { collisionRegionsForPhysics, mapGridGeometry, tileRect } from './core.js';
import ObjectSizeLibrary from './ObjectSizeLibrary.jsx';
import { download } from './exports.js';

const fields = [
  ['widthPx', '角色可见宽度 px', 1, 2048], ['heightPx', '角色可见高度 px', 8, 2048], ['footWidthPx', '脚底碰撞宽 px', 1, 1024], ['footDepthPx', '脚底碰撞深 px', 1, 1024],
  ['speedPx', '移动速度 px/秒', 1, 2000], ['doorHeightPx', '门洞高度 px', 8, 8192], ['doorWidthPx', '门洞净宽 px', 1, 8192],
  ['roadWidthPx', '道路最小净宽 px', 1, 8192], ['houseWidthCells', '小屋占地宽度（格）', 1, 32], ['houseDepthCells', '小屋占地深度（格）', 1, 32],
  ['treeMinHeightPx', '成年树最小高度 px', 8, 8192], ['treeMaxHeightPx', '成年树最大高度 px', 8, 8192],
];
function NumberField({ label, value, min, max, onChange, disabled, step = 1 }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label className="mx-field"><span>{label}</span><input type="number" min={min} max={max} step={step} value={draft} disabled={disabled} onChange={(event) => {
    setDraft(event.target.value); const number = Number(event.target.value);
    if (event.target.value !== '' && Number.isFinite(number) && number >= min && number <= max) onChange(number);
  }} onBlur={() => { const number = draft.trim() ? Number(draft) : value; const next = Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : value; setDraft(String(next)); onChange(next); }}/></label>;
}

export function ScaleReferencePanel({ project, engine, characterRef, walking, onFocus, notify }) {
  const s = normalizeScaleReference(project.scaleReference), input = useRef(null);
  const [imageUrl, setImageUrl] = useState('');
  useEffect(() => {
    let active = true; setImageUrl('');
    if (s.characterAssetId) engine.assets.url(s.characterAssetId).then((url) => active && setImageUrl(url)).catch(() => {});
    return () => { active = false; };
  }, [s.characterAssetId, engine.assets]);
  const patch = (change) => engine.updateScaleReference(change, true);
  const downloadCharacter = async () => {
    try { download(await engine.assets.get(s.characterAssetId), '临时角色-透明.png'); } catch (error) { notify(error.message); }
  };
  return <>
    <div className="mx-panel-heading"><small>SCALE REFERENCE</small><h2>角色标尺与物件尺寸</h2><p>无需角色图片即可启用尺寸约束；载入角色后可对照和试走。</p></div>
    <h3>角色标尺</h3>
    <label className="mx-check"><input type="checkbox" checked={s.enabled} disabled={engine.locked} onChange={(event) => patch({ enabled: event.target.checked })}/>启用生成比例约束</label>
    <fieldset className="mx-fieldset" disabled={engine.locked}>
      <div className="mx-two">{fields.slice(0, 2).map(([key, label, min, max]) => <NumberField key={key} label={label} value={s[key]} min={min} max={max} onChange={(value) => patch({ [key]: value })}/>)}</div>

    </fieldset>
    <ObjectSizeLibrary scale={s} onChange={patch} disabled={engine.locked}/>
    <details className="mx-scale-rules"><summary>地面占地与通行</summary><fieldset className="mx-fieldset" disabled={engine.locked}>      <h3>地面占地与通行</h3><p className="mx-hint">道路为净宽；小屋为地面占地格数，与建筑可见高度、碰撞范围分别设计。</p>
      <div className="mx-two">{fields.filter(([key]) => ['roadWidthPx', 'houseWidthCells', 'houseDepthCells'].includes(key)).map(([key, label, min, max]) => <NumberField key={key} label={label} value={s[key]} min={min} max={max} onChange={(value) => patch({ [key]: value })}/>)}</div>
</fieldset></details>
    <p className="mx-hint">角色可见宽度和高度会作为比例标尺发送给 AI；脚底碰撞与移动参数只用于本机试走。环境比例参数仅在勾选后附加到提示词。角色 PNG 不会上传。</p>
    <details className="mx-scale-rules"><summary>角色预览与试走</summary><fieldset className="mx-fieldset" disabled={engine.locked}>      <div className="mx-two">{fields.slice(2, 4).map(([key, label, min, max]) => <NumberField key={key} label={label} value={s[key]} min={min} max={max} onChange={(value) => patch({ [key]: value })}/>)}</div>
      <div className="mx-two">{fields.slice(4, 5).map(([key, label, min, max]) => <NumberField key={key} label={label} value={s[key]} min={min} max={max} onChange={(value) => patch({ [key]: value })}/>)}</div>
      <div className="mx-two"><NumberField label="脚底锚点 X（0–1）" value={s.feetX} min={0} max={1} step={.01} onChange={(feetX) => patch({ feetX })}/><NumberField label="脚底锚点 Y（0–1）" value={s.feetY} min={0} max={1} step={.01} onChange={(feetY) => patch({ feetY })}/></div>
</fieldset>
    <button className="mx-button primary" disabled={engine.locked} onClick={engine.loadScalePreset}>{s.characterAssetId ? '重新载入临时角色图片' : '载入临时角色图片'}</button>
    <p className="mx-hint">内置角色由可灵生成，载入不再调用 API。参数按最终地图像素计量。</p>
    {imageUrl && <div className="mx-scale-character-card"><div className="mx-scale-character-thumb bg-checker"><img src={imageUrl} alt="比例参考角色"/></div><div><strong>{s.widthPx} × {s.heightPx} px 可见尺寸</strong><span>脚底 {s.footWidthPx} × {s.footDepthPx} px</span><span>Unity 高度约 {(s.heightPx / (project.pixelsPerUnit || 100)).toFixed(2)} 单位</span></div></div>}
    <div className="mx-inline mx-scale-actions"><button className="mx-button" disabled={engine.locked} onClick={() => input.current?.click()}>替换角色 PNG</button><button className="mx-button" disabled={!s.characterAssetId} onClick={downloadCharacter}>下载 PNG</button><button className="mx-button" onClick={() => download(new Blob([JSON.stringify({ version: 1, units: 'final-map-pixels', pixelsPerUnit: project.pixelsPerUnit, scaleReference: s }, null, 2)], { type: 'application/json' }), '角色比例参数.json')}>下载参数</button></div>
    <input ref={input} type="file" accept="image/png" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) engine.importCharacter(file); }}/>
    <label className="mx-check"><input type="checkbox" checked={s.visible} disabled={!s.characterAssetId} onChange={(event) => patch({ visible: event.target.checked })}/>显示角色、身高尺与碰撞范围</label>
    <div className="mx-inline mx-scale-actions"><button className="mx-button" disabled={!s.enabled || !s.visible || !s.characterAssetId} onClick={onFocus}>以 100% 聚焦角色</button><button className={`mx-button ${walking ? 'primary' : ''}`} disabled={engine.locked || !s.enabled || !s.visible || !project.tiles.length || !s.characterAssetId} onClick={() => walking ? characterRef.current?.stop() : characterRef.current?.start()}>{walking ? '停止试走' : '开始试走'}</button></div>
    <p className="mx-hint">拖动角色摆放。试走使用 WASD / 方向键；键盘输入框和编辑工具会停止移动。{project.regions.some((r) => r.type === 'collision') ? '脚底椭圆用于碰撞；隐藏轮廓不会关闭碰撞。' : '当前没有碰撞区域，仅检查移动和比例。'}</p>
</details>
    <ol className="mx-scale-flow"><li>把角色拖到房门旁，检查身高和门洞。</li><li>调整比例参数，需要时重新生成主图。</li><li>在“区域”中标出墙壁、树干等碰撞区。</li><li>试走检查通道，合适后继续扩图。</li></ol>
  </>;
}

export const CharacterPreview = forwardRef(function CharacterPreview({ project, assets, zoom, locked, tool, onCommit, onWalkingChange, notify }, handle) {
  const scale = useMemo(() => normalizeScaleReference(project.scaleReference), [project.scaleReference]);
  const initial = scale.position || mapGridGeometry(project).center;
  const [position, setPosition] = useState(initial), [walking, setWalking] = useState(false), [blocked, setBlocked] = useState(false), [url, setUrl] = useState('');
  const currentPosition = useRef(position), keys = useRef(new Set()), drag = useRef(null), latest = useRef(null), wasMoving = useRef(false);
  const rectangles = useMemo(() => project.tiles.map((tile) => tileRect(project, tile)), [project.tiles, project.overlapX, project.overlapY, project.tileWidth, project.tileHeight]);
  const regions = useMemo(() => collisionRegionsForPhysics(project), [project.regions, project.grid, project.tiles, project.tileWidth, project.tileHeight, project.overlapX, project.overlapY]);
  latest.current = { project, scale, rectangles, regions, locked, onCommit, onWalkingChange, walking, notify };
  const commit = () => latest.current.onCommit(currentPosition.current);
  const stop = () => { keys.current.clear(); setWalking(false); latest.current.onWalkingChange(false); if (wasMoving.current) commit(); wasMoving.current = false; };
  useImperativeHandle(handle, () => ({
    position: () => currentPosition.current,
    stop,
    start: () => {
      const v = latest.current;
      if (v.locked || !v.scale.enabled || !v.scale.visible || !v.scale.bounds || !url) return;
      if (!canStandAt(currentPosition.current, v.scale, v.rectangles, v.regions)) { notify('请先把角色拖到已接纳地图中的空地，脚底不能压住碰撞区。'); return; }
      keys.current.clear(); setBlocked(false); setWalking(true); v.onWalkingChange(true);
    },
  }));
  useEffect(() => { let live = true; setUrl(''); if (scale.characterAssetId) assets.url(scale.characterAssetId).then((value) => live && setUrl(value)).catch(() => live && notify('角色素材读取失败，请重新载入临时方案。')); return () => { live = false; }; }, [assets, scale.characterAssetId, notify]);
  useEffect(() => {
    const next = scale.position || mapGridGeometry(project).center;
    currentPosition.current = next; setPosition(next);
  }, [project.id, project.tiles[0]?.id, scale.position?.x, scale.position?.y]);
  useEffect(() => { stop(); }, [project.id, tool, locked, scale.enabled, scale.visible, scale.characterAssetId, scale.widthPx, scale.heightPx, scale.footWidthPx, scale.footDepthPx, scale.feetX, scale.feetY]);
  useEffect(() => {
    if (!walking) return undefined;
    let animation, previous;
    const typing = (target) => /INPUT|TEXTAREA|SELECT/.test(target?.tagName || '') || target?.isContentEditable;
    const down = (event) => {
      if (typing(event.target)) { stop(); return; }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'].includes(key)) { event.preventDefault(); keys.current.add(key); }
      if (key === 'escape') stop();
    };
    const up = (event) => { keys.current.delete(event.key.toLowerCase()); if (!keys.current.size && wasMoving.current) { commit(); wasMoving.current = false; } };
    const focus = (event) => { if (typing(event.target)) stop(); };
    const hidden = () => { if (document.hidden) stop(); };
    const tick = (time) => {
      const dt = previous == null ? 0 : Math.min(.05, (time - previous) / 1000); previous = time;
      const k = keys.current, v = latest.current;
      const direction = { x: Number(k.has('d') || k.has('arrowright')) - Number(k.has('a') || k.has('arrowleft')), y: Number(k.has('s') || k.has('arrowdown')) - Number(k.has('w') || k.has('arrowup')) };
      if ((direction.x || direction.y) && !v.locked) {
        const result = advanceCharacter(currentPosition.current, direction, dt, v.scale, v.rectangles, v.regions);
        currentPosition.current = result.position; setPosition(result.position); setBlocked(result.blocked); wasMoving.current = true;
      }
      animation = requestAnimationFrame(tick);
    };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', stop); window.addEventListener('focusin', focus); document.addEventListener('visibilitychange', hidden);
    animation = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(animation); keys.current.clear(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', stop); window.removeEventListener('focusin', focus); document.removeEventListener('visibilitychange', hidden); };
  }, [walking]);
  useEffect(() => { const save = () => { if (wasMoving.current) commit(); }; window.addEventListener('beforeunload', save); return () => { window.removeEventListener('beforeunload', save); }; }, []);
  const placement = characterPlacement(scale, position);
  if (!scale.enabled || !scale.visible || !url || !placement) return null;
  const b = scale.bounds, x = scale.footWidthPx / 2, y = scale.footDepthPx / 2;
  return <div className={`mx-character-reference ${walking ? 'is-walking' : ''} ${blocked && walking ? 'is-blocked' : ''}`} style={{ left: position.x, top: position.y }} data-height-px={scale.heightPx} data-foot-x={position.x} data-foot-y={position.y} data-walking={walking} data-blocked={blocked}>
    <svg className="mx-character-footprint" style={{ left: -x, top: -y, width: x * 2, height: y * 2 }} viewBox={`0 0 ${x * 2} ${y * 2}`}><ellipse cx={x} cy={y} rx={x - .25} ry={y - .25}/><circle cx={x} cy={y} r={1.5}/></svg>
    <div className="mx-character-sprite" role="button" aria-label="拖动比例参考角色" title="拖动摆放角色；试走用 WASD / 方向键" style={{ left: placement.left - position.x, top: placement.top - position.y, width: placement.width, height: placement.height }} onPointerDown={(event) => {
      if (event.button !== 0) return; event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); stop(); drag.current = { clientX: event.clientX, clientY: event.clientY, position: { ...currentPosition.current } };
    }} onPointerMove={(event) => {
      if (!drag.current) return; event.stopPropagation(); const d = drag.current;
      const next = { x: d.position.x + (event.clientX - d.clientX) / zoom, y: d.position.y + (event.clientY - d.clientY) / zoom }; currentPosition.current = next; setPosition(next);
    }} onPointerUp={(event) => { if (!drag.current) return; event.stopPropagation(); drag.current = null; commit(); }} onPointerCancel={() => { drag.current = null; commit(); }}>
      <svg width="100%" height="100%" viewBox={`${b.x} ${b.y} ${b.width} ${b.height}`} preserveAspectRatio="none"><image href={url} width={b.sourceWidth} height={b.sourceHeight}/></svg>
    </div>
    <svg className="mx-character-ruler" style={{ left: placement.left - position.x - 10, top: placement.top - position.y, width: 8, height: scale.heightPx }} viewBox={`0 0 8 ${scale.heightPx}`}><path d={`M7 .5H1V${scale.heightPx - .5}H7 M1 ${scale.heightPx / 2}H5`}/></svg>
    <span className="mx-character-caption" style={{ left: 0, top: y + 5, fontSize: 10 / zoom }}>{scale.heightPx} px · 脚底 {Math.round(position.x)}, {Math.round(position.y)}{walking ? blocked ? ' · 碰撞阻挡' : ' · 试走中' : ''}</span>
  </div>;
});
