import { useRef, useState } from 'react';
import { layerGenerationPrompts } from './layerPrompts.js';
import { download, safeName } from './exports.js';
import { geminiGroundFrame, geminiGroundResolutions, resolveGeminiGround } from './geminiResolution.js';
import { needsMatteCheck } from './layers.js';
import { matteValid } from './chromaKey.js';

function Field({ label, children }) { return <label className="mx-field"><span>{label}</span>{children}</label>; }
function Button({ children, primary = false, ...props }) { return <button className={`mx-button ${primary ? 'primary' : ''}`} {...props}>{children}</button>; }
const taskStatus = { waiting: '等待', running: '生成中', done: '完成', failed: '失败' };

export default function DirectLayerControls({ project, tile, engine, notify, config, maskEditing, onMaskEditingChange,
  maskPaintMode, setMaskPaintMode, maskBrushSize, setMaskBrushSize, maskThreshold, setMaskThreshold, maskFeather, setMaskFeather }) {
  const objectInput = useRef(null), groundInput = useRef(null), [layerSubdivisions, setLayerSubdivisions] = useState(1), [layerConcurrency, setLayerConcurrency] = useState(1);
  const draft = tile?.layerDraft, layers = draft || tile, gemini = project.provider === 'gemini', model = config?.models?.gemini || '';
  const groundQuality = project.groundResolution || 'auto', supported = geminiGroundResolutions(model);
  const rawMaskId = draft?.rawMaskId || tile?.rawMaskId || '', maskId = draft?.maskId || tile?.maskId || '', maskAvailable = Boolean(rawMaskId);
  const eligible = project.tiles.filter((item) => !item.objectsId && !item.layerDraft?.objectsId).length;
  const queue = project.layerQueue, queueDone = queue?.tasks.filter((task) => task.status === 'done').length || 0;
  const canAcceptAll = project.tiles.some((item) => item.layerDraft?.objectsId && item.layerDraft?.layerMode === 'mask');
  let estimate;
  if (gemini && tile) {
    const frame = geminiGroundFrame(tile.width, tile.height);
    try { estimate = { ...resolveGeminiGround(model, groundQuality, frame.width, frame.height), ...frame }; }
    catch (e) { estimate = { error: e.message }; }
  }
  const promptFor = (kind) => layerGenerationPrompts(kind, tile?.width || project.tileWidth, tile?.height || project.tileHeight, project.layerPrompts?.[kind] || '').prompt;
  const setPrompt = (kind, value) => engine.patch({ layerPrompts: { ...project.layerPrompts, [kind]: value } });
  const save = async (kind) => { try { download(await engine.assets.get((draft || tile)[`${kind}Id`]), `${safeName(project.name)}-${kind === 'objects' ? '物件层' : '地面层'}.png`); } catch (e) { notify(e.message); } };
  const saveRaw = async () => { try { const ext = layers.groundRawMimeType === 'image/jpeg' ? 'jpg' : layers.groundRawMimeType === 'image/webp' ? 'webp' : 'png'; download(await engine.assets.get(layers.groundRawAssetId), `${safeName(project.name)}-地面层-服务原始结果.${ext}`); } catch (e) { notify(e.message); } };
  const applyMatteSettings = () => engine.editMatte(null, maskThreshold, maskFeather);
  const maskDraft = Boolean(draft?.layerMode === 'mask' && draft.objectsId);
  const batchCount = eligible * layerSubdivisions * layerSubdivisions;

  return <>
    <div className="mx-layer-workflow">
      <strong>推荐：蒙版提取原图物件</strong>
      <p className="mx-hint">AI 只判断物件轮廓，物件颜色和细节直接取自原图；检查蒙版后可手工补画或擦除。</p>
      <Button primary disabled={engine.locked || !tile} onClick={() => { onMaskEditingChange(false); engine.matte(false); }}>为选中图块生成蒙版 · 1 次请求</Button>
      {maskAvailable && <>
        <div className="mx-mask-editor">
          <div className="mx-inline"><strong>蒙版画笔</strong><Button primary={maskEditing} disabled={engine.locked} onClick={() => onMaskEditingChange(!maskEditing)}>{maskEditing ? '结束画笔' : '在画布上编辑'}</Button></div>
          <div className="mx-inline"><Button primary={maskPaintMode === 'add'} disabled={engine.locked || !maskEditing} onClick={() => setMaskPaintMode('add')}>白笔添加</Button><Button primary={maskPaintMode === 'erase'} disabled={engine.locked || !maskEditing} onClick={() => setMaskPaintMode('erase')}>黑笔擦除</Button></div>
          <Field label={`画笔大小 ${maskBrushSize} px`}><input type="range" min="2" max="240" value={maskBrushSize} disabled={engine.locked || !maskEditing} onChange={(event) => setMaskBrushSize(+event.target.value)}/></Field>
          <Field label={`蒙版阈值 ${maskThreshold}`}><input type="range" min="0" max="255" value={maskThreshold} disabled={engine.locked} onChange={(event) => setMaskThreshold(+event.target.value)}/></Field>
          <Field label={`边缘羽化 ${maskFeather} px`}><input type="range" min="0" max="12" value={maskFeather} disabled={engine.locked} onChange={(event) => setMaskFeather(+event.target.value)}/></Field>
          <Button disabled={engine.locked} onClick={applyMatteSettings}>应用阈值 / 羽化并提取像素</Button>
          <p className="mx-hint">白色蒙版区域显示为粉色叠层。画笔按地图像素工作；右键或空格仍可拖动画布。</p>
        </div>
        <div className="mx-inline">
          <Button disabled={engine.locked || !maskId} onClick={engine.ground}>从蒙版生成地面层 · 1 次请求</Button>
          <Button disabled={!layers?.objectsId} onClick={() => save('objects')}>下载物件 PNG</Button>
        </div>
        {maskDraft && <p className="mx-hint">物件层已从原图提取，RGB 不经模型重绘；可以先接纳物件层，地面补图稍后独立处理。</p>}
      </>}
    </div>

    <div className="mx-layer-workflow mx-layer-batch">
      <strong>生成所有物件蒙版</strong>
      <p className="mx-hint">处理地图中尚无物件层的图块。每块的蒙版可分段生成，结果先保存为待检查预览。</p>
      <fieldset className="mx-fieldset" disabled={engine.locked || !project.tiles.length}>
        <Field label="每块蒙版分段"><select value={layerSubdivisions} onChange={(event) => setLayerSubdivisions(+event.target.value)}><option value="1">整块 · 1 次请求</option><option value="2">2 × 2 · 4 次请求</option><option value="3">3 × 3 · 9 次请求</option></select></Field>
        <Field label="同时生成"><select value={layerConcurrency} onChange={(event) => setLayerConcurrency(+event.target.value)}><option value="1">1 块 · 顺序生成</option><option value="2">2 块</option><option value="3">3 块</option></select></Field>
      </fieldset>
      <div className="mx-estimate"><strong>{eligible}</strong><span>个待处理图块 · 预计 {batchCount} 次请求<br/>失败后暂停，不会自动重复提交</span></div>
      <Button primary disabled={engine.locked || !eligible} onClick={() => engine.startLayerBatch(layerSubdivisions, layerConcurrency)}>开始生成所有物件蒙版</Button>
      {queue && <div className="mx-queue">
        <h3>物件蒙版队列 <span>{queueDone} / {queue.tasks.length}</span></h3><progress max={queue.tasks.length || 1} value={queueDone}/>
        <div className="mx-inline">
          {queue.status === 'running' && <Button onClick={engine.pauseLayerBatch}>暂停</Button>}
          {['paused', 'stopped'].includes(queue.status) && <Button primary disabled={engine.layerPumpActive} onClick={engine.resumeLayerBatch}>{queue.tasks.some((task) => task.status === 'failed') ? '继续 / 重试失败' : '继续'}</Button>}
          {['running', 'pausing', 'paused'].includes(queue.status) && <Button onClick={engine.stopLayerBatch}>停止</Button>}
          {canAcceptAll && <Button primary disabled={engine.locked} onClick={engine.acceptAllLayers}>批量接纳预览</Button>}
          <Button disabled={engine.layerPumpActive || Boolean(engine.busy) || !queue.baseline} onClick={engine.undoLayerBatch}>撤销本批</Button>
        </div>
        <p className="mx-hint">运行状态：{({ running: '生成中', pausing: '等待当前请求完成', paused: '已暂停', stopped: '已停止', complete: '已完成' })[queue.status] || queue.status}。每块结果可单独预览接纳；失败任务只会在你点击重试后重新请求。</p>
        <div className="mx-task-list">{queue.tasks.map((task) => <div key={task.id} className={`mx-task ${task.status}`}>
          <button className="mx-layer-task-select" disabled={engine.locked} onClick={() => engine.setSelectedId(task.tileId)}>{task.x}, {task.y}</button>
          <span>{taskStatus[task.status]}{task.completedParts.length ? ` · ${task.completedParts.length}/${queue.subdivisions ** 2} 分段` : ''}</span>{task.error && <small>{task.error}</small>}
        </div>)}</div>
      </div>}
    </div>

    {gemini && <div className="mx-layer-workflow mx-ground-quality"><Field label="地面层输出质量"><select value={groundQuality} disabled={engine.locked} onChange={(event) => engine.patch({ groundResolution: event.target.value })}>{!supported.includes(groundQuality) && <option value={groundQuality}>{groundQuality} · 当前模型不支持</option>}{supported.map((quality) => <option key={quality} value={quality}>{quality === 'auto' ? '自动匹配原图' : quality}</option>)}</select></Field>
      {estimate && <p className="mx-hint" role="status">{estimate.error || <>原图 {tile.width} × {tile.height}；发送 {estimate.width} × {estimate.height}。请求 {estimate.resolvedResolution === 'native' ? '服务默认档位' : estimate.resolvedResolution}{estimate.expectedWidth ? `（预计 ${estimate.expectedWidth} × ${estimate.expectedHeight}）` : ''}。{estimate.warning} 高档位通常增加费用和等待时间。</>}</p>}
    </div>}

    <div className="mx-inline">
      <button className="mx-button" disabled={engine.locked || !tile} onClick={() => objectInput.current.click()}>导入物件 PNG</button>
      <button className="mx-button" disabled={engine.locked || !tile} onClick={() => groundInput.current.click()}>导入地面 PNG</button>
    </div>
    {['objects', 'ground'].map((kind) => <input key={kind} ref={kind === 'objects' ? objectInput : groundInput} aria-label={`导入${kind === 'objects' ? '物件' : '地面'}图层文件`} type="file" accept="image/png" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) engine.importLayer(file, kind); }}/>) }

    {['objects', 'ground'].filter((kind) => layers?.[`${kind}Id`]).map((kind) => { const info = layers[`${kind}Generation`]; return <div className="mx-layer-status" key={kind}><strong>{kind === 'objects' ? '物件层' : '地面层'}</strong>
      {layers.layerMode === 'mask' && kind === 'objects'
        ? <span>蒙版提取 · 原图像素 · {tile.width} × {tile.height} px</span>
        : info ? <>
          <span>原图 {info.sourceWidth} × {info.sourceHeight} · 发送 {info.referenceWidth} × {info.referenceHeight}</span>
          <span>模型 {info.model || '未记录'} · 请求 {info.requestedResolution === 'auto' ? '自动' : info.requestedResolution} → {info.resolvedResolution === 'native' ? '服务默认' : info.resolvedResolution || '服务默认'}</span>
          <span>实际返回 {info.actualWidth} × {info.actualHeight} · 地图对齐 {info.alignedWidth} × {info.alignedHeight}</span>
          {(info.upscaled || info.warning) && <span className="mx-layer-invalid">{info.upscaled ? '实际返回尺寸不足，对齐版本已放大；放大不会增加原生细节。' : info.warning}</span>}
        </>
        : <span>{layers[`${kind}ActualWidth`]} × {layers[`${kind}ActualHeight`]} → {tile.width} × {tile.height} px</span>}
      <span className={layers[`${kind}Valid`] === false ? 'mx-layer-invalid' : ''}>{kind === 'objects' && needsMatteCheck(layers) ? matteValid(layers.objectsMatteStats) ? '透明与紫底检查通过，请继续检查轮廓' : '尚未通过紫底检查，请本地清理后再接纳' : layers[`${kind}Valid`] !== false ? kind === 'objects' ? 'Alpha 透明已检查，请检查物件轮廓' : '全画幅不透明已检查' : '图层检查未通过'}</span>
      {kind === 'objects' && layers.objectsMatteStats && <><button className="mx-button" disabled={engine.locked} onClick={engine.cleanObjects}>本地清理紫底 · 无需生图</button><span>清理 {layers.objectsMatteStats.removedPixels.toLocaleString()} 像素 · 边缘修整 {layers.objectsMatteStats.decontaminatedPixels.toLocaleString()} 像素。</span></>}
      <button className="mx-button" onClick={() => save(kind)}>{kind === 'ground' ? '下载对齐地图版本 · PNG' : '下载物件预览'}</button>{kind === 'ground' && layers.groundRawAssetId && <button className="mx-button" onClick={saveRaw}>下载服务原始结果</button>}
    </div>; })}

    <details className="mx-layer-prompt-settings"><summary>编辑分层提示词</summary><p className="mx-hint">提示词独立于场景描述。蒙版提示词只用于识别物件范围。</p>{['matte', 'ground'].map((kind) => <label className="mx-field" key={kind}><span>{{ matte: '物件蒙版提示词', ground: '地面层提示词' }[kind]}</span><textarea rows="6" maxLength="8000" disabled={engine.locked} value={promptFor(kind)} onChange={(event) => setPrompt(kind, event.target.value)}/><button className="mx-button" disabled={engine.locked} onClick={() => setPrompt(kind, '')}>恢复默认提示词</button></label>)}</details>
  </>;
}
