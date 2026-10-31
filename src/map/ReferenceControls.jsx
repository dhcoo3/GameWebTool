import { useEffect, useRef, useState } from 'react';
import { normalizeReferenceSettings, effectiveReference, REFERENCE_MODES } from './reference.js';
import { referenceSample } from './referenceImages.js';

export function ReferenceSummary({ project, operation = 'seed' }) {
  const r = effectiveReference(project), s = project.scaleReference;
  return <p className="mx-hint mx-reference-summary">{operation === 'seed' ? `参考：${r.hasImage || r.positive || r.negative ? `${REFERENCE_MODES[r.mode]} · ${r.input === 'text' ? '文字风格（不发送图片）' : r.crop ? '局部图片' : '整图'}` : '无参考'}` : '本次使用已有地图的位置与衔接，不使用初始参考图设置'}<br/>{s?.enabled ? `比例标尺：${s.heightPx} px · ${s.environmentRulesEnabled ? s.objectSizes?.entries.filter((e) => e.enabled).length || 0 : 0} 个启用物件类别` : '比例约束未启用'}。</p>;
}
export default function ReferenceControls({ project, engine, config, notify, onUpload }) {
  const s = normalizeReferenceSettings(project.referenceSettings), r = effectiveReference(project);
  const [url, setUrl] = useState(''), [sampleUrl, setSampleUrl] = useState(''), [selecting, setSelecting] = useState(false), [draft, setDraft] = useState(null), start = useRef(null), imageRef = useRef(null);
  const patch = (value) => engine.patch({ referenceSettings: { ...s, ...value } }, true);
  useEffect(() => { let live = true; setUrl(''); if (project.styleAssetId) engine.assets.url(project.styleAssetId).then((u) => live && setUrl(u)).catch(() => live && notify('参考图读取失败，请重新上传。')); setSelecting(false); setDraft(null); return () => { live = false; }; }, [project.styleAssetId, engine.assets]);
  useEffect(() => {
    let live = true, objectUrl;
    setSampleUrl('');
    if (project.styleAssetId) referenceSample(project, engine.assets).then((c) => c.toBlob((blob) => { if (blob && live) { objectUrl = URL.createObjectURL(blob); setSampleUrl(objectUrl); } })).catch(() => {});
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [project.styleAssetId, s.mode, JSON.stringify(s.crop), engine.assets]);
  const position = (event) => { const b = imageRef.current.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - b.left) / b.width)), y: Math.max(0, Math.min(1, (event.clientY - b.top) / b.height)) }; };
  const selection = (event) => { const end = position(event), from = start.current; return { x: Math.min(from.x, end.x), y: Math.min(from.y, end.y), width: Math.abs(from.x - end.x), height: Math.abs(from.y - end.y) }; };
  const stale = s.source && (s.source.sourceAssetId !== project.styleAssetId || JSON.stringify(s.source.crop) !== JSON.stringify(s.crop));
  return <div className="mx-reference-controls">
    <h3>参考图</h3>
    <button className="mx-button" disabled={engine.locked} onClick={onUpload}>{project.styleAssetId ? '替换参考图' : '上传参考图'}</button>
    {project.styleAssetId && <button className="mx-button" disabled={engine.locked} onClick={() => engine.patch({ styleAssetId: '' })}>移除参考图</button>}
    <label className="mx-field"><span>参考用途</span><select aria-label="参考用途" value={s.mode} disabled={engine.locked} onChange={(e) => patch({ mode: e.target.value })}>{Object.entries(REFERENCE_MODES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    {s.mode === 'style' && <label className="mx-field"><span>风格输入方式</span><select aria-label="风格输入方式" value={s.input} disabled={engine.locked} onChange={(e) => patch({ input: e.target.value })}><option value="image">直接图片参考</option><option value="text">文字风格</option></select></label>}
    {url && <>
      <div className={`mx-style-crop ${selecting ? 'selecting' : ''}`} style={{ position: 'relative', touchAction: selecting ? 'none' : 'auto' }} onPointerDown={(e) => { if (!selecting || engine.locked || e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); start.current = position(e); setDraft({ ...start.current, width: 0, height: 0 }); }} onPointerMove={(e) => { if (start.current && selecting) setDraft(selection(e)); }} onPointerUp={(e) => { if (!start.current || !selecting) return; const crop = selection(e); start.current = null; if (crop.width >= .01 && crop.height >= .01) { patch({ crop }); setSelecting(false); setDraft(null); } else { setDraft(null); notify('取样范围太小，请重新框选。'); } }} onPointerCancel={() => { start.current = null; setDraft(null); }}>
        <img ref={imageRef} src={url} draggable={false} alt="参考原图"/>
        {s.mode === 'style' && (draft || s.crop) && <div className="mx-style-crop-box" style={{ left: `${(draft || s.crop).x * 100}%`, top: `${(draft || s.crop).y * 100}%`, width: `${(draft || s.crop).width * 100}%`, height: `${(draft || s.crop).height * 100}%` }}/>}
      </div>
      {s.mode === 'style' && <><div className="mx-inline"><button className="mx-button" disabled={engine.locked} onClick={() => { setSelecting(!selecting); setDraft(null); start.current = null; }}>{selecting ? '取消取样' : '框选局部风格样本'}</button><button className="mx-button" disabled={engine.locked || !s.crop} onClick={() => { patch({ crop: null }); setDraft(null); }}>恢复整图</button></div>{selecting && <p className="mx-hint">在参考图上拖动框选；仅在本机取样，不调用AI。</p>}{s.crop && sampleUrl && <div className="mx-reference"><img src={sampleUrl} alt="局部风格样本"/></div>}</>}
      {s.mode !== 'style' && <p className="mx-hint">布局参考使用完整原图，保留局部取样设置但不应用。可按比例库调整道路和建筑尺寸，不锁定像素位置。</p>}
    </>}
    {s.mode === 'style' && <>
      <details className="mx-scale-rules" open={s.input === 'text' ? true : undefined}><summary>风格文字与AI提炼</summary>
        <label className="mx-field"><span>提示词服务</span><select aria-label="风格提炼服务" value={s.provider} disabled={engine.locked} onChange={(e) => patch({ provider: e.target.value })}>{['gemini', 'openai', 'qwen'].map((p) => <option key={p} value={p}>{{ gemini: 'Gemini', openai: 'OpenAI', qwen: '千问' }[p]} · {config.configured[p] ? '已配置' : '未配置'}</option>)}</select></label>
        <button className="mx-button" disabled={engine.locked || !project.styleAssetId} onClick={engine.extractStyle}>AI提炼文字风格 · 1次调用</button>
        <p className="mx-hint">仅点击才调用所选服务；不自动重提炼或生成图片。提炼结果可编辑，切到文字风格后不发送参考图。</p>
        {s.source?.model && <p className="mx-hint">上次提炼模型：{s.source.model}</p>}
        {stale && <p className="mx-hint" role="status">参考图或取样已变化，现有文字来自之前的参考。可继续使用，也可主动重新提炼。</p>}
        <label className="mx-field"><span>正向风格描述</span><textarea aria-label="正向风格描述" rows={4} value={s.positive} disabled={engine.locked} onChange={(e) => patch({ positive: e.target.value })}/></label>
        <label className="mx-field"><span>反向风格要求</span><textarea aria-label="反向风格要求" rows={3} value={s.negative} disabled={engine.locked} onChange={(e) => patch({ negative: e.target.value })}/></label>
      </details>
    </>}
    <p className="mx-hint">物件尺寸以启用的比例库为准。参考模式用于引导，模型仍可能继承布局或尺度，生成后请用角色叠加检查。</p>
  </div>;
}
