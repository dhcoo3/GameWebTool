import { useState } from 'react';
import { REFERENCE_MODES } from './reference.js';
const OPERATIONS = { seed: '初始图 / 主图重生成', expand: '手动扩图（各分段）', retouch: '局部重绘', matte: '整图物件蒙版', 'ground-mask': '蒙版修补地面', objects: '独立物件层', ground: '独立地面层' };
function Diagnostic({ data, label, notify }) {
  if (!data) return <p className="mx-hint">本次请求未返回最终诊断信息（可能连接中断或服务未更新）。</p>;
  const copy = async () => { try { await navigator.clipboard.writeText([data.prompt, data.negativePrompt && `\nNegative prompt:\n${data.negativePrompt}`].filter(Boolean).join('\n')); notify('最终提示词已复制。'); } catch { notify('复制失败，可在文本框中手动全选复制。'); } };
  return <details className="mx-prompt-diagnostic" open><summary>{label}</summary>
    <p className="mx-hint">{data.provider} · {data.model}<br/>{data.width} × {data.height} · {data.resolution}<br/>参考：{REFERENCE_MODES[data.referenceMode] || (data.referenceInput === 'map' ? '已有地图' : '无参考')} · {data.hasImage ? '发送图片' : '不发送图片'}{data.hasMask ? ' · 有遮罩' : ''}<br/>{data.scale?.enabled ? `角色 ${data.scale.heightPx} px · ${data.scale.objectCount} 类物件` : '比例约束未启用'}<br/>正向 {data.positiveChars} / 反向 {data.negativeChars} 字符{data.limit ? ` · 上限各 ${data.limit}` : ''}。反向要求{data.negativeHandling === 'inline' ? '已合入正向' : '独立发送'}。</p>
    {data.validationError && <p className="mx-error">{data.validationError}</p>}
    <label className="mx-field"><span>最终正向提示词</span><textarea aria-label="最终正向提示词" rows={8} readOnly value={data.prompt}/></label>
    <label className="mx-field"><span>最终反向提示词</span><textarea aria-label="最终反向提示词" rows={3} readOnly value={data.negativePrompt || ''}/></label>
    <button className="mx-button" onClick={copy}>复制完整提示词</button>
  </details>;
}
export default function PromptInspector({ engine, direction, points, prompt, notify, initialOperation = 'seed' }) {
  const [operation, setOperation] = useState(initialOperation), [results, setResults] = useState([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const preview = async () => { setLoading(true); setError(''); setResults([]); try { setResults(await engine.previewPrompts(operation, { direction, points, prompt })); } catch (e) { setError(e.message); } finally { setLoading(false); } };
  const trace = engine.project.requestLog;
  return <>
    <div className="mx-panel-heading"><small>REQUEST INSPECTOR</small><h2>最终提示词</h2><p>预览不调用AI、不产生生图费用。模型和服务规则在实际提交时重新确定，以实际记录为准。</p></div>
    <label className="mx-field"><span>预览操作</span><select aria-label="预览操作" value={operation} disabled={loading} onChange={(e) => { setOperation(e.target.value); setResults([]); }}>{Object.entries(OPERATIONS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    <button className="mx-button" disabled={loading || engine.locked} onClick={preview}>{loading ? '正在准备…' : '查看最终发送提示词'}</button>
    {operation === 'expand' && <p className="mx-hint">按分段编号展示本次范围的提示词；后续分段的图片参考会包含此前生成内容。实际发送内容见下方记录。</p>}
    {error && <p className="mx-error" role="alert">{error}</p>}
    {results.map((r, i) => <Diagnostic key={i} data={r} label={`预览 ${i + 1}${r.part ? ` · 分段 ${r.part}` : ''}`} notify={notify}/>)}
    <h3>最近一次生成任务</h3><p className="mx-hint">只保留最近一次任务的完整记录；新任务首次提交后替换旧记录。自动任务按请求／分段分组，暂停恢复继续追加；记录随项目和ZIP保存，不保存密钥或图片Base64。</p>
    {trace ? <><strong>{trace.name} · {trace.requests.length} 次请求</strong>{trace.requests.map((r, i) => <details className="mx-prompt-record" key={r.requestId}><summary>请求 {i + 1} · {r.operation} {r.requestTag} · {{ pending: '等待响应', success: '成功', failed: '失败', cancelled: '已取消' }[r.status]}</summary><p className="mx-hint">{r.submitted === false ? '未提交到图像服务' : r.submitted === true ? '已提交到图像服务' : '提交状态未知'}{r.error ? ` · ${r.error}` : ''}</p><Diagnostic data={r.diagnostics} label="实际提交内容" notify={notify}/></details>)}</> : <p className="mx-hint">暂无生成请求记录。</p>}
  </>;
}
