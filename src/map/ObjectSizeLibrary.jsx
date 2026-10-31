import { useState } from 'react';
import { OBJECT_DEFINITIONS, applySizeStandard, rescaleObjectSizes } from './objectSizes.js';
import { uid } from './core.js';

function RangeEditor({ label, value, onChange, disabled }) {
  const [draft, setDraft] = useState(null), current = draft || value;
  return <div className="mx-size-range"><span>{label}</span>{['min', 'max'].map((key) => <label key={key}><span>{key === 'min' ? '最小' : '最大'}</span><input aria-label={`${label}${key === 'min' ? '最小' : '最大'}`} type="number" min="1" max="8192" disabled={disabled} value={current[key]} onChange={(event) => {
    const text = event.target.value, next = { ...current, [key]: text }; setDraft(next);
    const min = Number(next.min), max = Number(next.max);
    if (next.min !== '' && next.max !== '' && Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max <= 8192 && min <= max) { onChange({ min: Math.round(min), max: Math.round(max) }); setDraft(null); }
  }} onBlur={() => setDraft(null)}/></label>)}</div>;
}
export default function ObjectSizeLibrary({ scale, onChange, disabled }) {
  const library = scale.objectSizes;
  const [customOpen, setCustomOpen] = useState(false);
  const update = (id, change) => onChange({ objectSizes: { ...library, entries: library.entries.map((e) => e.id === id ? { ...e, ...change } : e) } });
  const row = (entry) => {
    const builtin = OBJECT_DEFINITIONS.find((d) => d.id === entry.id);
    const widthLabel = entry.id === 'door' ? '门洞净宽 px' : ['tree', 'smallTree'].includes(entry.id) ? '树冠宽 px' : '可见宽度 px';
    return <div className="mx-size-entry" key={entry.id}>
      <label className="mx-check"><input type="checkbox" checked={entry.enabled} onChange={(e) => update(entry.id, { enabled: e.target.checked })}/>{builtin ? entry.name : '启用自定义类别'}</label>
      {!builtin && <label className="mx-field"><span>类别名称</span><input value={entry.name} maxLength={80} onChange={(e) => update(entry.id, { name: e.target.value })}/></label>}
      <RangeEditor label={`${entry.name}高度 px`} value={entry.height} onChange={(height) => update(entry.id, { height })} disabled={disabled}/>
      <label className="mx-check"><input type="checkbox" checked={Boolean(entry.width)} onChange={(e) => update(entry.id, { width: e.target.checked ? { min: 1, max: 20 } : null })}/>限定{widthLabel}</label>
      {entry.width && <RangeEditor label={`${entry.name}${widthLabel}`} value={entry.width} onChange={(width) => update(entry.id, { width })} disabled={disabled}/>}
      {!builtin && <button className="mx-danger-link" onClick={() => onChange({ objectSizes: { ...library, entries: library.entries.filter((e) => e.id !== entry.id) } })}>删除 {entry.name}</button>}
    </div>;
  };
  return <fieldset className="mx-fieldset" disabled={disabled}>
    <h3>物件尺寸库</h3><p className="mx-hint">所有尺寸为最终地图可见像素，不含透明边距、投影与光晕。勾选只约束实际出现的物件，不要求生成它们。</p>
    <label className="mx-check"><input type="checkbox" checked={scale.environmentRulesEnabled} onChange={(e) => onChange({ environmentRulesEnabled: e.target.checked })}/>将物件库与环境尺寸附加到 AI 提示词</label>
    <div className="mx-inline mx-scale-actions"><button className="mx-button" onClick={() => onChange(applySizeStandard(scale))}>应用44像素规范</button><button className="mx-button" onClick={() => onChange(rescaleObjectSizes(scale))}>按当前角色高度等比调整物件库</button></div>
    <p className="mx-hint">物件库标尺高度 {library.rulerHeightPx} px；当前角色 {scale.heightPx} px。等比调整同时缩放道路净宽，占地格数不变。</p>
    {['地面点缀', '道具与障碍', '植物', '建筑与入口', '自定义'].map((group) => <details className="mx-scale-rules" key={group} {...(group === '自定义' ? { open: customOpen, onToggle: (event) => setCustomOpen(event.currentTarget.open) } : {})}><summary>{group}</summary>{library.entries.filter((e) => (OBJECT_DEFINITIONS.find((d) => d.id === e.id)?.group || '自定义') === group).map(row)}</details>)}
    <button className="mx-button" onClick={() => { setCustomOpen(true); onChange({ objectSizes: { ...library, entries: [...library.entries, { id: `custom-${uid()}`, name: '自定义物件', enabled: true, height: { min: 10, max: 20 }, width: null }] } }); }}>＋ 添加自定义类别</button>
    <p className="mx-hint">蘑菇、地面残骸参照草石；罐子、矿筐、水晶参照箱桶；墓碑、路障、低石笋参照大箱子或岩石；高石笋、石柱参照树木；洞口、拱门参照门洞。围栏可沿长度方向延展。</p>
  </fieldset>;
}
