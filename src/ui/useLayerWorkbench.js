import { useEffect, useState } from 'react';
import { getUiAsset, putUiAsset } from './storage.js';
import { applySourceMask, cropPixels } from './layers.js';
import { decodePixels, layerCropBlob, maskRgba, reassembleLayers, renderLayers, rgbaPng } from './raster.js';

export function blobBase64(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
}
export function base64Blob(value, type = 'image/png') { return new Blob([Uint8Array.from(atob(value), (c) => c.charCodeAt(0))], { type }); }
async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败。'); return result;
}

export function useLayerWorkbench({ project, setProject, selectedId, setBusy, setError, notify }) {
  const [status, setStatus] = useState(null), [rendered, setRendered] = useState(null);
  const [view, setView] = useState('boxes'), [background, setBackground] = useState('checker');
  const [hiddenIds, setHiddenIds] = useState([]), [restoreTarget, setRestoreTarget] = useState('__background__');
  const [maskConfirmed, setMaskConfirmed] = useState(false), [previewUrl, setPreviewUrl] = useState('');
  const [cropUrl, setCropUrl] = useState(''), [overlayUrl, setOverlayUrl] = useState('');
  const selectedLayer = rendered?.layers.find((layer) => layer.asset.id === selectedId);
  const targetLayer = rendered?.layers.find((layer) => layer.asset.id === restoreTarget);
  const restoration = project?.restorations?.[restoreTarget];
  const refreshStatus = () => fetch('/api/ui/segmentation/status').then((r) => r.json()).then(setStatus).catch(() => setStatus({ error: '本机服务离线' }));
  useEffect(() => { refreshStatus(); }, []);
  useEffect(() => { setMaskConfirmed(false); }, [project?.assets, project?.sourceAssetId, restoreTarget]);
  useEffect(() => { setHiddenIds([]); setRendered(null); }, [project?.id, project?.sourceAssetId]);
  useEffect(() => {
    if (!project?.sourceAssetId || project.pipelineVersion !== 2) return;
    let active = true;
    const timer = setTimeout(async () => {
      try { const result = await renderLayers(project, await getUiAsset(project.sourceAssetId)); if (active) setRendered(result); }
      catch (error) { if (active) { setRendered(null); setError(error.message); } }
    }, 160);
    return () => { active = false; clearTimeout(timer); };
  }, [project?.assets, project?.restorations, project?.sourceAssetId, project?.pipelineVersion, project?.width, project?.height]);

  useEffect(() => {
    let active = true; const urls = [];
    const url = (blob) => { const value = URL.createObjectURL(blob); urls.push(value); return value; };
    const build = async () => {
      if (!rendered) { setPreviewUrl(''); setCropUrl(''); setOverlayUrl(''); return; }
      const { width, height } = rendered.source;
      setCropUrl(selectedLayer?.bounds ? url(layerCropBlob(selectedLayer, width)) : '');
      setOverlayUrl(selectedLayer ? url(rgbaPng(maskRgba(selectedLayer.mask, true), width, height)) : '');
      let data;
      if (view === 'layer') data = reassembleLayers(rendered, [], selectedId);
      else if (view === 'reassembled') data = reassembleLayers(rendered, hiddenIds);
      else if (view === 'restore-mask' && targetLayer) {
        const tinted = maskRgba(targetLayer.hiddenMask, true); data = new Uint8ClampedArray(rendered.source.data);
        for (let i = 0; i < data.length; i += 4) if (tinted[i + 3]) { data[i] = Math.round(data[i] * .5 + 127); data[i + 1] = Math.round(data[i + 1] * .5); data[i + 2] = Math.round(data[i + 2] * .5 + 100); }
      } else if (view === 'restore-raw' && restoration) {
        const raw = await getUiAsset(restoration.rawAssetId); if (active) setPreviewUrl(url(raw)); return;
      } else if (view === 'restore-composite' && restoration && targetLayer) {
        const generated = (await decodePixels(await getUiAsset(restoration.normalizedAssetId), { width, height })).data;
        const mask = (await decodePixels(await getUiAsset(restoration.maskAssetId), { width, height })).data;
        const effective = Uint8Array.from(targetLayer.hiddenMask, (v, i) => v && mask[i * 4] ? 255 : 0);
        data = applySourceMask(rendered.source.data, new Uint8Array(width * height).fill(255), generated, effective);
      } else { if (active) setPreviewUrl(''); return; }
      if (active) setPreviewUrl(url(rgbaPng(data, width, height)));
    };
    build().catch((error) => { if (active) setError(error.message); });
    return () => { active = false; urls.forEach(URL.revokeObjectURL); };
  }, [rendered, selectedId, view, hiddenIds, restoreTarget, restoration]);

  const work = async (label, task) => { setBusy(label); setError(''); try { await task(); } catch (error) { setError(error.message); } finally { setBusy(''); } };
  const invalidate = (current, assets) => ({ ...current, pipelineVersion: 2, assets: assets.map((a) => ({ ...a, reviewed: false })), approved: false,
    restorations: Object.fromEntries(Object.entries(current.restorations || {}).map(([id, r]) => [id, { ...r, accepted: false }])) });

  const segment = (ids, regionMode = 'full') => work('本机正在分割像素轮廓', async () => {
    const imageBase64 = await blobBase64(await getUiAsset(project.sourceAssetId));
    const assets = project.assets.filter((a) => ids.includes(a.id)).map(({ id, bounds }) => ({ id, bounds }));
    const result = await post('/api/ui/assets/segment', { imageBase64, assets, regionMode });
    const updates = new Map(), blobIds = [];
    for (const asset of result.assets) {
      const candidates = await Promise.all(asset.candidates.filter((c) => c.selectedPixels > 0).map(async (candidate) => {
        const maskAssetId = await putUiAsset(base64Blob(candidate.maskBase64)); blobIds.push(maskAssetId);
        const { maskBase64, ...metadata } = candidate; return { ...metadata, maskAssetId, regionMode };
      }));
      if (!candidates.length) throw new Error('分割返回空蒙版，请调整范围重试；未替换为矩形。');
      updates.set(asset.id, { maskCandidates: candidates, maskAssetId: candidates[0].maskAssetId, maskBounds: candidates[0].maskBounds,
        extractionMode: 'mask', maskStale: false, maskStrokes: [], maskRedo: [], segmentDevice: result.device });
    }
    setProject((current) => current.id !== project.id || current.sourceAssetId !== project.sourceAssetId ? current : {
      ...invalidate(current, current.assets.map((a) => updates.has(a.id) ? { ...a, ...updates.get(a.id) } : a)),
      sourceHash: result.source.sha256, blobIds: [...(current.blobIds || []), ...blobIds],
    });
    setStatus((old) => ({ ...old, device: result.device, fallbackReason: result.fallbackReason, modelReady: true }));
    setView('layer'); notify('轮廓已生成，请在棋盘格和黑白背景下验边。');
  });

  const refineBounds = () => work('AI 正在校正局部范围', async () => {
    const asset = project.assets.find((a) => a.id === selectedId); if (!asset) return;
    const source = await decodePixels(await getUiAsset(project.sourceAssetId), project), b = asset.bounds;
    const pad = Math.max(64, Math.ceil(Math.max(b.width, b.height) * .2));
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    const bounds = { x, y, width: Math.min(project.width, b.x + b.width + pad) - x, height: Math.min(project.height, b.y + b.height + pad) - y };
    const crop = rgbaPng(cropPixels(source.data, project.width, bounds), bounds.width, bounds.height);
    const result = await post('/api/ui/assets/analyze', { provider: project.analysisProvider, imageBase64: await blobBase64(crop), imageMimeType: 'image/png', width: bounds.width, height: bounds.height,
      goal: `Return exactly ONE component: ${asset.name}. Include all its ornaments and text; exclude neighboring captions. Coordinates refer to this local image.` });
    if (result.analysis.assets.length !== 1) throw new Error('局部识别未返回唯一对象，请保留原框并人工校正。');
    const item = result.analysis.assets[0];
    setProject((current) => current.id !== project.id ? current : invalidate(current, current.assets.map((a) => a.id === asset.id ? { ...a, bounds: { x: x + item.x, y: y + item.y, width: item.width, height: item.height }, maskStale: Boolean(a.maskAssetId) } : a)));
    setView('boxes'); notify('局部框已映射回原图，请重新分割轮廓。');
  });

  const restore = () => work('Gemini 正在补齐被遮挡区域', async () => {
    if (!maskConfirmed || !targetLayer?.hiddenMask.some(Boolean)) throw new Error('请先预览并确认非空的补齐范围。');
    const mask = rgbaPng(maskRgba(targetLayer.hiddenMask), project.width, project.height);
    const source = rgbaPng(rendered.source.data, project.width, project.height);
    const result = await post('/api/ui/layers/restore', { provider: 'gemini', maskConfirmed: true, layerName: targetLayer.asset.name, width: project.width, height: project.height,
      imageBase64: await blobBase64(source), maskBase64: await blobBase64(mask) });
    const raw = base64Blob(result.imageBase64, result.mimeType), normalized = await decodePixels(raw, project, true);
    const [maskAssetId, rawAssetId, normalizedAssetId] = await Promise.all([putUiAsset(mask), putUiAsset(raw), putUiAsset(rgbaPng(normalized.data, project.width, project.height))]);
    setProject((current) => current.id !== project.id ? current : ({ ...current, approved: false,
      blobIds: [...(current.blobIds || []), maskAssetId, rawAssetId, normalizedAssetId],
      restorations: { ...current.restorations, [restoreTarget]: { maskAssetId, rawAssetId, normalizedAssetId, accepted: false, model: result.model } },
    }));
    setView('restore-composite'); notify('补齐候选已保存；确认局部合成结果后才参与导出。');
  });

  return { status, refreshStatus, rendered, view, setView, background, setBackground, hiddenIds, setHiddenIds, previewUrl, cropUrl, overlayUrl,
    selectedLayer, targetLayer, restoreTarget, setRestoreTarget, maskConfirmed, setMaskConfirmed, restoration, segment, refineBounds, restore };
}
