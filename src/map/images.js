import { processStitch } from './stitch.js';
import { overlapBand } from './stitchMath.js';
import { effectiveReference } from './reference.js';
import { seedReference } from './referenceImages.js';
import { assetFor, intersection, polygonBounds, splitRect, tileRect, uid } from './core.js';
import { mapGenerationPrompts } from './prompts.js';
import { scaleRequestContext } from './scale.js';
import { layerGenerationPrompts, LAYER_OPERATIONS } from './layerPrompts.js';
import { geminiGroundFrame, MAP_REQUEST_LIMIT } from './geminiResolution.js';
import { cleanMagenta, matteValid } from './chromaKey.js';
import { gptImageSize } from './gptImageSize.js';
import { gptExpansionFrame } from './gptExpansion.js';
import { opaqueTerrainPixels } from './terrainAlpha.js';
import { LEGACY_EXPANSION } from './simpleExpansion.js';

export function canvas(width, height) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (w > 16384 || h > 16384 || w * h > 120_000_000) throw new Error('合成尺寸超过画布安全范围，请使用分块 PNG / 项目 ZIP 导出。');
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
export function cleanObjectMatte(imageCanvas, referenceCanvas) {
  const ctx = imageCanvas.getContext('2d', { willReadFrequently: true });
  const frame = ctx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
  const reference = referenceCanvas?.getContext('2d').getImageData(0, 0, imageCanvas.width, imageCanvas.height).data;
  const stats = cleanMagenta(frame.data, imageCanvas.width, imageCanvas.height, reference);
  ctx.putImageData(frame, 0, 0); return stats;
}
export function removeGeminiObjectMatte(imageCanvas) { return matteValid(cleanObjectMatte(imageCanvas)); }
export const canvasBlob = (c) => new Promise((resolve, reject) => c.toBlob((b) => b ? resolve(b) : reject(new Error('PNG 编码失败。')), 'image/png'));
export async function storeCanvas(c, assets) { return assets.put(await canvasBlob(c)); }
export function loadImage(url) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('图片解码失败。')); img.src = url; });
}
export async function assetImage(id, assets) { return loadImage(await assets.url(id)); }
export async function importImage(file, assets, maxEdge = 4096) {
  if (!/^image\/(png|jpeg|webp)$/.test(file?.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  const image = await createImageBitmap(file), scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const c = canvas(image.width * scale, image.height * scale);
  c.getContext('2d').drawImage(image, 0, 0, c.width, c.height); image.close();
  return { assetId: await storeCanvas(c, assets), width: c.width, height: c.height };
}
function path(ctx, points, origin = { x: 0, y: 0 }) {
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x - origin.x, p.y - origin.y) : ctx.moveTo(p.x - origin.x, p.y - origin.y)); ctx.closePath();
}
export async function renderRect(project, assets, rect, layer = 'composite', { cutRegions = false } = {}) {
  const output = canvas(rect.width, rect.height), ctx = output.getContext('2d');
  const prior = [];
  for (const tile of project.tiles) {
    const r = tileRect(project, tile), overlap = intersection(r, rect);
    if (!overlap) continue;
    const patch = canvas(overlap.width, overlap.height), pc = patch.getContext('2d');
    const draw = async (id) => { if (id) pc.drawImage(await assetImage(id, assets), overlap.x - r.x, overlap.y - r.y, overlap.width, overlap.height, 0, 0, patch.width, patch.height); };
    if (layer === 'composite') {
      if (project.visibility.ground) await draw(assetFor(tile, 'ground'));
      if (project.visibility.objects) await draw(assetFor(tile, 'objects'));
    } else await draw(layer === 'object-source' ? tile.objectsId || tile.originalId : assetFor(tile, layer));
    // Earlier accepted tiles own the complete intersection, including transparent pixels.
    for (const owned of prior) {
      const cut = intersection(owned, overlap);
      if (cut) pc.clearRect(cut.x - overlap.x, cut.y - overlap.y, cut.width, cut.height);
    }
    ctx.drawImage(patch, overlap.x - rect.x, overlap.y - rect.y); prior.push(r);
  }
  // Only foreground pixels are split into independent sorting regions. The ground
  // (including the complete original-image fallback) must remain intact.
  if (cutRegions === true && layer === 'objects') {
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#fff';
    for (const region of project.regions.filter((r) => ['occlusion', 'top'].includes(r.type) && r.visible !== false)) { path(ctx, region.points, rect); ctx.fill(); }
    ctx.globalCompositeOperation = 'source-over';
  }
  return output;
}
export async function renderRegion(project, assets, region) {
  const r = polygonBounds(region.points), result = await renderRect(project, assets, r, 'object-source');
  const mask = canvas(r.width, r.height), mc = mask.getContext('2d'); path(mc, region.points, r); mc.fill();
  const ctx = result.getContext('2d'); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0); ctx.globalCompositeOperation = 'source-over';
  return { canvas: result, rect: r };
}
function coverage(project, rect, parts = [], target = null) {
  const c = canvas(rect.width, rect.height), ctx = c.getContext('2d'); ctx.fillStyle = '#fff';
  for (const t of project.tiles) { const r = tileRect(project, t); ctx.fillRect(r.x - rect.x, r.y - rect.y, r.width, r.height); }
  if (target) for (const p of parts) ctx.fillRect(target.x + p.rect.x - rect.x, target.y + p.rect.y - rect.y, p.rect.width, p.rect.height);
  return c;
}
export async function referenceForPart(project, assets, target, part, parts) {
  if (['openai','apiyi'].includes(project.provider)) {
    const area={x:target.x+part.x,y:target.y+part.y,width:part.width,height:part.height};
    const rect=gptExpansionFrame(area,[...project.tiles.map(t=>tileRect(project,t)),...parts.map(p=>({...p.rect,x:target.x+p.rect.x,y:target.y+p.rect.y}))]);
    const image=await renderRect(project,assets,rect,'original');
    for(const p of parts) image.getContext('2d').drawImage(await assetImage(p.assetId,assets),target.x+p.rect.x-rect.x,target.y+p.rect.y-rect.y);
    const mask=coverage(project,rect,parts,target);
    // Unknown pixels outside the requested segment remain protected.
    const allowed=canvas(rect.width,rect.height),ac=allowed.getContext('2d');ac.fillStyle='#fff';ac.fillRect(0,0,rect.width,rect.height);
    ac.clearRect(area.x-rect.x,area.y-rect.y,area.width,area.height);ac.drawImage(mask,0,0);
    for(const t of project.tiles){const b=overlapBand(target,tileRect(project,t));const hit=b&&intersection(b,area);if(hit)ac.clearRect(hit.x-rect.x,hit.y-rect.y,hit.width,hit.height);}
    return {image,mask:allowed,rect,pad:0,offsetX:area.x-rect.x,offsetY:area.y-rect.y,gptAnchor:true};
  }
  const needsContext = project.expansionContextEnabled === true;
  const pad = needsContext ? Math.max(1, Math.round(Math.min(part.width, part.height) * .25)) : 0;
  const rect = { x: target.x + part.x - pad, y: target.y + part.y - pad, width: part.width + pad * 2, height: part.height + pad * 2 };
  const image = await renderRect(project, assets, rect, 'original'), ctx = image.getContext('2d');
  for (const completed of parts) ctx.drawImage(await assetImage(completed.assetId, assets), target.x + completed.rect.x - rect.x, target.y + completed.rect.y - rect.y, completed.rect.width, completed.rect.height);
  const known = coverage(project, rect, parts, target), mask = canvas(rect.width, rect.height), mc = mask.getContext('2d');
  mc.fillStyle = '#fff'; mc.fillRect(0, 0, mask.width, mask.height); mc.clearRect(pad, pad, part.width, part.height); mc.drawImage(known, 0, 0);
  for (const t of project.tiles) { const band = overlapBand(target, tileRect(project, t)); if (band) mc.clearRect(band.x-rect.x,band.y-rect.y,band.width,band.height); }
  // The editable output is always the target segment, never the enlarged context.
  // Context is a separate reference; the output is mapped to the target frame.
  // Models can still alter their apparent camera or object scale.
  const targetImage=canvas(part.width,part.height),targetMask=canvas(part.width,part.height),targetKnown=canvas(part.width,part.height);
  targetImage.getContext('2d').drawImage(image,pad,pad,part.width,part.height,0,0,part.width,part.height);
  targetMask.getContext('2d').drawImage(mask,pad,pad,part.width,part.height,0,0,part.width,part.height);
  targetKnown.getContext('2d').drawImage(known,pad,pad,part.width,part.height,0,0,part.width,part.height);
  return { image:targetImage,mask:targetMask,known:targetKnown,rect:{x:target.x+part.x,y:target.y+part.y,width:part.width,height:part.height},pad:0,contextImage:image,contextMask:mask,contextRect:rect,contextPad:pad };

}
function providerRatio(provider, ratio) {
  if (provider === 'qwen') return Math.max(1 / 8, Math.min(8, ratio));
  const list = ['openai', 'apiyi'].includes(provider) ? [1, 1.5, 2 / 3] : provider === 'kling' ? [1, 16 / 9, 9 / 16, 4 / 3, 3 / 4, 1.5, 2 / 3, 21 / 9] : [1, 4 / 3, 1.5, 16 / 9, 5 / 4, 4 / 5, 3 / 4, 2 / 3, 9 / 16, 21 / 9];
  return list.reduce((best, v) => Math.abs(Math.log(ratio / v)) < Math.abs(Math.log(ratio / best)) ? v : best, 1);
}
export function frameReference(image, mask, provider, { preservePixels = false, outputRatio } = {}) {
  const ratio = outputRatio || providerRatio(provider, image.width / image.height);
  let w = image.width, h = image.height;
  if (w / h > ratio) h = Math.ceil(w / ratio); else w = Math.ceil(h * ratio);
  if (preservePixels && provider === 'gemini') { const frame = geminiGroundFrame(image.width, image.height); w = frame.width; h = frame.height; }
  const scale = preservePixels ? 1 : Math.min(1, 1536 / Math.max(w, h)), x = Math.floor((w - image.width) / 2), y = Math.floor((h - image.height) / 2);
  const framed = canvas(w * scale, h * scale), ctx = framed.getContext('2d');
  if (preservePixels) { ctx.fillStyle = '#242424'; ctx.fillRect(0, 0, framed.width, framed.height); }
  const draw = { x: x * scale, y: y * scale, width: image.width * scale, height: image.height * scale };
  ctx.drawImage(image, draw.x, draw.y, draw.width, draw.height);
  let framedMask;
  if (mask) {
    framedMask = canvas(framed.width, framed.height); const mc = framedMask.getContext('2d');
    mc.fillStyle = '#fff'; mc.fillRect(0, 0, framed.width, framed.height);
    mc.clearRect(x * scale, y * scale, image.width * scale, image.height * scale);
    mc.drawImage(mask, x * scale, y * scale, image.width * scale, image.height * scale);
  }
  return { image: framed, mask: framedMask, crop: { x: draw.x / framed.width, y: draw.y / framed.height, width: draw.width / framed.width, height: draw.height / framed.height } };
}
export function restorePixels(generated, original, mask) {
  const c = canvas(original.width, original.height), ctx = c.getContext('2d'); ctx.drawImage(generated, 0, 0, c.width, c.height);
  const out = ctx.getImageData(0, 0, c.width, c.height), src = original.getContext('2d').getImageData(0, 0, c.width, c.height), m = mask.getContext('2d').getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < out.data.length; i += 4) {
    const keep = m.data[i + 3] / 255;
    if (keep === 1) { out.data.set(src.data.subarray(i, i + 4), i); continue; }
    if (keep > 0) for (let k = 0; k < 4; k++) out.data[i + k] = Math.round(src.data[i + k] * keep + out.data[i + k] * (1 - keep));
  }
  ctx.putImageData(out, 0, 0); return c;
}
export function mattePartPlan(width, height, divisions = 1) {
  const rects = splitRect(width, height, divisions);
  return rects.map((rect, index) => {
    const pad = rects.length > 1 ? Math.max(32, Math.round(Math.min(rect.width, rect.height) * .12)) : 0;
    const left = Math.max(0, rect.x - pad), top = Math.max(0, rect.y - pad);
    const right = Math.min(width, rect.x + rect.width + pad), bottom = Math.min(height, rect.y + rect.height + pad);
    return { index, rect, reference: { x: left, y: top, width: right - left, height: bottom - top } };
  });
}
export async function prepareMapImage(project, assets, operation, { image, mask, width, height, prompt, contextImage } = {}) {
  if (operation === 'seed') {
    if (effectiveReference(project).input === 'text') image = undefined;
    else if (!image) image = await seedReference(project, assets);
  }
  let framed, guideCanvas, requestCanvas = image;
  const customGptSize = project.provider === 'apiyi' && project.resolution !== 'native' ? gptImageSize(image?.width || width || project.tileWidth, image?.height || height || project.tileHeight, project.resolution) : null;
  const layerOperation = LAYER_OPERATIONS.includes(operation);
  const supportsMaskedEdits = ['openai', 'apiyi'].includes(project.provider);
  const geminiGround = project.provider === 'gemini' && operation === 'ground';
  const preservePixels = geminiGround || project.provider === 'gemini' && ['2K', '4K'].includes(project.resolution);
  // Omni extraction uses the whole reference frame with auto aspect ratio, without padding/cropping.
  const klingObjects = image && project.provider === 'kling' && operation === 'objects';
  if (klingObjects) {
    const factor = Math.max(300 / Math.min(image.width, image.height), Math.min(1, 2048 / Math.max(image.width, image.height)));
    requestCanvas = canvas(image.width * factor, image.height * factor); requestCanvas.getContext('2d').drawImage(image, 0, 0, requestCanvas.width, requestCanvas.height);
  } else if (image && !(layerOperation && supportsMaskedEdits)) { framed = frameReference(image, mask, project.provider, { preservePixels, outputRatio: customGptSize ? customGptSize.width / customGptSize.height : operation==='expand' && supportsMaskedEdits ? image.width/image.height : undefined }); requestCanvas = framed.image; }
  // Non-mask integrations receive a separate visible editing guide. Protected pixels are restored locally afterward.
  if (requestCanvas && framed?.mask) {
    const guide = canvas(requestCanvas.width, requestCanvas.height), gc = guide.getContext('2d'); gc.drawImage(requestCanvas, 0, 0);
    const editable = canvas(requestCanvas.width, requestCanvas.height), ec = editable.getContext('2d'); ec.fillStyle = 'rgba(255,45,112,.42)'; ec.fillRect(0, 0, editable.width, editable.height);
    ec.globalCompositeOperation = 'destination-out'; ec.drawImage(framed.mask, 0, 0); gc.drawImage(editable, 0, 0);
    if (project.provider === 'kling') requestCanvas = guide; else if (!supportsMaskedEdits) guideCanvas = guide;
  }
  const base64 = (c) => c ? c.toDataURL('image/png').split(',')[1] : '';
  const scaleReference = ['seed', 'expand', 'retouch'].includes(operation) ? scaleRequestContext(project, image?.width || width || project.tileWidth, image?.height || height || project.tileHeight, framed?.crop) : undefined;
  const layerPrompt = layerOperation ? project.layerPrompts?.[operation] || '' : '';
  const prompts = layerOperation ? layerGenerationPrompts(operation, requestCanvas?.width || width || project.tileWidth, requestCanvas?.height || height || project.tileHeight, layerPrompt) : mapGenerationPrompts(operation, prompt ?? (operation === 'expand' ? project.expansionDescription?.trim() || project.prompt : project.prompt), project.negativePrompt, scaleReference);
  const requestedResolution = geminiGround ? project.groundResolution || 'auto' : project.resolution;
  const body = JSON.stringify({
    operation, provider: project.provider, ...prompts, ...(operation === 'seed' ? { reference: effectiveReference(project) } : {}), ...(!layerOperation && ['seed', 'expand', 'retouch'].includes(operation) ? { globalPositivePrompt: project.globalPositivePrompt || '', globalNegativePrompt: project.globalNegativePrompt || '' } : {}), ...(layerOperation ? { layerPrompt } : {}), ...(scaleReference ? { scaleReference } : {}),
    width: requestCanvas?.width || width || project.tileWidth, height: requestCanvas?.height || height || project.tileHeight,
    ...(customGptSize ? { outputWidth: image?.width || width || project.tileWidth, outputHeight: image?.height || height || project.tileHeight } : {}),
    contextImageBase64: project.provider !== 'kling' ? base64(contextImage) : '', imageBase64: base64(requestCanvas), guideImageBase64: base64(guideCanvas), maskBase64: base64(framed?.mask || mask), mimeType: 'image/png', resolution: requestedResolution,
    markedGuide: Boolean(framed?.mask) && !supportsMaskedEdits, separateGuide: Boolean(guideCanvas),
  });
  if (new TextEncoder().encode(body).byteLength > MAP_REQUEST_LIMIT) throw new Error('原图请求超过 36 MB 上传限制。为保留细节，未缩小图片，也未提交生成；请手动缩小原图或使用较小地图。');
  return { body, image, mask, width, height, framed, requestCanvas, requestedResolution, preservePixels };
}
export async function requestImage(project, assets, operation, options = {}) {
  const { signal, fetcher = fetch, preserveRaw = false, previewOnly = false, requestTag = '' } = options;
  const prepared = await prepareMapImage(project, assets, operation, options);
  const { body, image, mask, width, height, framed, requestCanvas, requestedResolution } = prepared;
  if (previewOnly) {
    const response = await fetcher('/api/map/preview', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '提示词预览失败。');
    return result.diagnostics;
  }
  const requestId = uid(), taskId = assets.requestTaskId;
  const record = (change) => assets.onRequest?.({ requestId, taskId, operation, requestTag, ...change });
  record({ status: 'pending', startedAt: Date.now(), provider: project.provider });
  let result;
  try {
    const response = await fetcher('/api/map/generate', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body });
    result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || `图像生成失败（${response.status}）。`), { diagnostics: result.diagnostics, submitted: result.submitted });
  if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
  if (!result.imageBase64) throw new Error('服务没有返回图像。');
  const raw = await loadImage(`data:${result.mimeType || 'image/png'};base64,${result.imageBase64}`);
  let rawAssetId;
  if (preserveRaw || operation === 'expand') {
    const bytes = Uint8Array.from(atob(result.imageBase64), (c) => c.charCodeAt(0));
    rawAssetId = await assets.put(new Blob([bytes], { type: result.mimeType || 'image/png' }));
  }
  const out = canvas(image?.width || width || project.tileWidth, image?.height || height || project.tileHeight), oc = out.getContext('2d');
  if (framed) { const r = framed.crop; oc.drawImage(raw, raw.width * r.x, raw.height * r.y, raw.width * r.width, raw.height * r.height, 0, 0, out.width, out.height); }
  else oc.drawImage(raw, 0, 0, out.width, out.height);
  // A terrain result must not inherit the transparent outpainting canvas.
  // Keep returned RGB (matting over black would darken every semi-transparent pixel).
  if(['openai','apiyi'].includes(project.provider)&&['seed','expand','retouch'].includes(operation)) {
    const pixels=oc.getImageData(0,0,out.width,out.height);
    opaqueTerrainPixels(pixels.data);
    oc.putImageData(pixels,0,0);
  }
  const alignedAssetId = operation === 'expand' ? await storeCanvas(out, assets) : undefined;
  const postprocess = options.beforeRestore ? await options.beforeRestore(out) : undefined;
  const restored = mask ? restorePixels(out, image, mask) : out;
  const geminiObjects = project.provider === 'gemini' && operation === 'objects';
  const matteSourceAssetId = geminiObjects ? await storeCanvas(restored, assets) : undefined;
  const matteStats = geminiObjects ? cleanObjectMatte(restored, image) : undefined;
  const chromaKeyRemoved = geminiObjects ? matteValid(matteStats) : undefined;
  record({ status: 'success', diagnostics: result.diagnostics || null, submitted: result.submitted ?? true, finishedAt: Date.now() });
  return { canvas: restored, alignedAssetId, postprocess, chromaKeyRemoved, actualWidth: raw.width, actualHeight: raw.height, model: result.model,
    matteSourceAssetId, matteStats, rawAssetId, rawMimeType: result.mimeType || 'image/png', generation: {
      ...result.generation, opaqueTerrain: ['openai','apiyi'].includes(project.provider)&&['seed','expand','retouch'].includes(operation), requestedResolution, resolvedResolution: result.generation?.resolvedResolution || requestedResolution, model: result.model,
      sourceWidth: image?.width || out.width, sourceHeight: image?.height || out.height,
      referenceWidth: requestCanvas?.width || out.width, referenceHeight: requestCanvas?.height || out.height,
      inputPolicy: operation === 'expand' ? 'target-frame-v1' : undefined, contextWidth: options.contextImage?.width, contextHeight: options.contextImage?.height, crop: framed?.crop || { x: 0, y: 0, width: 1, height: 1 }, actualWidth: raw.width, actualHeight: raw.height, alignedWidth: out.width, alignedHeight: out.height,
      upscaled: raw.width * (framed?.crop.width || 1) + .5 < out.width || raw.height * (framed?.crop.height || 1) + .5 < out.height,
    } };
  } catch (error) {
    record({ status: signal?.aborted ? 'cancelled' : 'failed', error: error.message, diagnostics: error.diagnostics || result?.diagnostics || null, submitted: error.submitted ?? result?.submitted ?? null, finishedAt: Date.now() });
    throw error;
  }
}
function nextExpansionPart(project, target, rectangles, completed) {
  const remaining = rectangles.map((r, index) => ({ ...r, index })).filter((r) => !completed.some((p) => p.index === r.index));
  // Start at the strongest existing edge; subsequent parts can use completed siblings.
  const score = (r) => {
      const world = { ...r, x: target.x + r.x - 24, y: target.y + r.y - 24, width: r.width + 48, height: r.height + 48 };
      return [...project.tiles.map((t) => tileRect(project, t)), ...completed.map((p) => ({ ...p.rect, x: target.x + p.rect.x, y: target.y + p.rect.y }))].reduce((sum, t) => { const i = intersection(world, t); return sum + (i ? i.width * i.height : 0); }, 0);
  };
  return remaining.sort((a, b) => score(b) - score(a) || a.index - b.index)[0];
}
function expansionPartInputs(project, reference) {
  if(reference.gptAnchor) return reference;
  return { image: reference.image, mask: reference.mask, contextImage: project.expansionContextEnabled === true ? reference.contextImage : undefined, pad: reference.pad, rect: reference.rect };
}
export async function generateTile(project, assets, targetSlot, { parts = [], onPart, signal, fetcher, requestTag = '', expansionPolicy = project.expansionPolicy || LEGACY_EXPANSION } = {}) {
  if (expansionPolicy !== LEGACY_EXPANSION) throw new Error('简化扩图流程已停用，请重新创建扩图任务。');
  const target = tileRect(project, targetSlot), rectangles = splitRect(project.tileWidth, project.tileHeight, project.subdivisions);
  const completed = [...parts]; let metadata = {};
  while (completed.length < rectangles.length) {
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const part = nextExpansionPart(project, target, rectangles, completed);
    const reference = await referenceForPart(project, assets, target, part, completed);
    const input = expansionPartInputs(project, reference);
    const result = await requestImage(project, assets, 'expand', { ...input, signal, fetcher, requestTag: `${requestTag} / 分段 ${part.index + 1}` });
    const cropped = canvas(part.width, part.height); cropped.getContext('2d').drawImage(result.canvas, input.offsetX ?? input.pad, input.offsetY ?? input.pad, part.width, part.height, 0, 0, part.width, part.height);
    const assetId = await storeCanvas(cropped, assets);
    const item = { alignedAssetId: result.alignedAssetId, rawAssetId: result.rawAssetId, generation: result.generation, referenceRect: input.rect, pad: input.pad, offsetX:input.offsetX,offsetY:input.offsetY, index: part.index, rect: { x: part.x, y: part.y, width: part.width, height: part.height }, assetId };
    completed.push(item); metadata = result;
    await onPart?.([...completed]);
  }
  const full = canvas(project.tileWidth, project.tileHeight), fc = full.getContext('2d');
  for (const part of completed) fc.drawImage(await assetImage(part.assetId, assets), part.rect.x, part.rect.y, part.rect.width, part.rect.height);
  const generated = { id: uid(), x: targetSlot.x, y: targetSlot.y, px: target.x, py: target.y, width: full.width, height: full.height,
    originalId: await storeCanvas(full, assets), name: `地图块 ${targetSlot.x}, ${targetSlot.y}`, kind: 'generated', addedAt: Date.now(),
    actualWidth: metadata.actualWidth, actualHeight: metadata.actualHeight, model: metadata.model, completedParts: completed };
  const processed = await processStitch(project, assets, generated);
  return { ...processed.tile, stitchUpdates: processed.updates };
}
export async function processedMatte(tile, assets, rawMaskId, threshold = 128, feather = 1) {
  const raw = canvas(tile.width, tile.height), rc = raw.getContext('2d'); rc.drawImage(await assetImage(rawMaskId, assets), 0, 0, raw.width, raw.height);
  const data = rc.getImageData(0, 0, raw.width, raw.height);
  for (let i = 0; i < data.data.length; i += 4) { const a = (.2126 * data.data[i] + .7152 * data.data[i + 1] + .0722 * data.data[i + 2]) >= threshold ? 255 : 0; data.data[i] = data.data[i + 1] = data.data[i + 2] = 255; data.data[i + 3] = a; }
  rc.putImageData(data, 0, 0);
  const alpha = canvas(raw.width, raw.height), ac = alpha.getContext('2d'); ac.filter = `blur(${Math.max(0, feather)}px)`; ac.drawImage(raw, 0, 0); ac.filter = 'none';
  const objects = canvas(raw.width, raw.height), oc = objects.getContext('2d'); oc.drawImage(await assetImage(tile.originalId, assets), 0, 0, objects.width, objects.height); oc.globalCompositeOperation = 'destination-in'; oc.drawImage(alpha, 0, 0);
  return { maskId: await storeCanvas(alpha, assets), objectsId: await storeCanvas(objects, assets) };
}
export async function generateMatteTile(project, assets, tile, { divisions = 1, completedParts = [], onPart, signal, fetcher, requestTag = '' } = {}) {
  const source = canvas(tile.width, tile.height), sourceContext = source.getContext('2d');
  sourceContext.drawImage(await assetImage(tile.originalId, assets), 0, 0, source.width, source.height);
  const parts = mattePartPlan(source.width, source.height, divisions), completed = [...completedParts];
  const validPart = (part) => Number.isInteger(part.index) && part.index >= 0 && part.index < parts.length &&
    part.rect?.x === parts[part.index].rect.x && part.rect?.y === parts[part.index].rect.y &&
    part.rect?.width === parts[part.index].rect.width && part.rect?.height === parts[part.index].rect.height && part.assetId;
  for (const part of completed) if (!validPart(part)) throw new Error('已保存的蒙版分段与当前图块不匹配，请清除队列后重试。');
  for (const partPlan of parts) {
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    if (completed.some((part) => part.index === partPlan.index)) continue;
    const { index, rect, reference: frame } = partPlan;
    const reference = canvas(frame.width, frame.height);
    reference.getContext('2d').drawImage(source, frame.x, frame.y, frame.width, frame.height, 0, 0, frame.width, frame.height);
    const result = await requestImage(project, assets, 'matte', { image: reference, signal, fetcher, requestTag: `${requestTag} / 分段 ${index + 1}` });
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const core = canvas(rect.width, rect.height);
    core.getContext('2d').drawImage(result.canvas, rect.x - frame.x, rect.y - frame.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const item = { index, rect, assetId: await storeCanvas(core, assets) };
    completed.push(item); await onPart?.([...completed]);
  }
  const rawMask = canvas(source.width, source.height), rawContext = rawMask.getContext('2d');
  rawContext.fillStyle = '#000'; rawContext.fillRect(0, 0, rawMask.width, rawMask.height);
  for (const part of completed) rawContext.drawImage(await assetImage(part.assetId, assets), part.rect.x, part.rect.y, part.rect.width, part.rect.height);
  return { rawMask, completedParts: completed };
}
export async function groundInputs(assets, tile, maskId) {
  const image = canvas(tile.width, tile.height); image.getContext('2d').drawImage(await assetImage(tile.originalId, assets), 0, 0, tile.width, tile.height);
  let mask;
  if (maskId) { mask = canvas(tile.width, tile.height); const mc = mask.getContext('2d'); mc.fillStyle = '#fff'; mc.fillRect(0, 0, mask.width, mask.height); mc.globalCompositeOperation = 'destination-out'; mc.drawImage(await assetImage(maskId, assets), 0, 0, mask.width, mask.height); }
  return { image, mask };
}
export async function generateGround(project, assets, tile, maskId, signal) {
  const result = await requestImage(project, assets, 'ground', { ...await groundInputs(assets, tile, maskId), signal });
  return storeCanvas(result.canvas, assets);
}
export async function retouchInputs(project, assets, tile, points, prompt) {
  const rect = tileRect(project, tile), image = canvas(tile.width, tile.height); image.getContext('2d').drawImage(await assetImage(tile.originalId, assets), 0, 0, tile.width, tile.height);
  const mask = canvas(tile.width, tile.height), mc = mask.getContext('2d'); mc.fillStyle = '#fff'; mc.fillRect(0, 0, mask.width, mask.height); mc.globalCompositeOperation = 'destination-out'; path(mc, points, rect); mc.fill();
  return { image, mask, prompt };
}
export async function retouchTile(project, assets, tile, points, prompt, signal) {
  const result = await requestImage(project, assets, 'retouch', { ...await retouchInputs(project, assets, tile, points, prompt), signal });
  return { ...tile, originalId: await storeCanvas(result.canvas, assets), groundId: '', objectsId: '', maskId: '', rawMaskId: '', layerDraft: null, actualWidth: result.actualWidth, actualHeight: result.actualHeight };
}

export async function previewExpansionTemplate(project, assets, targetSlot) {
  const target = tileRect(project, targetSlot), rectangles = splitRect(project.tileWidth, project.tileHeight, project.subdivisions);
  const work = project.work;
  const completed = work?.status === 'paused' && work.target?.x === targetSlot.x && work.target?.y === targetSlot.y ? work.completedParts || [] : [];
  const part = nextExpansionPart(project, target, rectangles, completed);
  if (!part) throw new Error('该扩图任务没有待生成的分段。');
  const reference = await referenceForPart(project, assets, target, part, completed);
  const prepared = await prepareMapImage(project, assets, 'expand', expansionPartInputs(project, reference));
  const request = JSON.parse(prepared.body);
  return { image: prepared.requestCanvas.toDataURL('image/png'), width: prepared.requestCanvas.width, height: prepared.requestCanvas.height, part: part.index + 1, editMask: ['openai', 'apiyi'].includes(project.provider), maskImage: request.maskBase64 ? `data:image/png;base64,${request.maskBase64}` : '', guideImage: request.guideImageBase64 ? `data:image/png;base64,${request.guideImageBase64}` : '', contextImage: request.contextImageBase64 ? `data:image/png;base64,${request.contextImageBase64}` : '' };
}

export async function previewExpansion(project, assets, targetSlot, { signal } = {}) {
  const target = tileRect(project, targetSlot), rectangles = splitRect(project.tileWidth, project.tileHeight, project.subdivisions), results = [];
  for (let index = 0; index < rectangles.length; index++) {
    const reference = await referenceForPart(project, assets, target, rectangles[index], []);
    const diagnostics = await requestImage(project, assets, 'expand', { ...expansionPartInputs(project, reference), signal, previewOnly: true });
    results.push({ ...diagnostics, part: index + 1 });
  }
  return results;
}
export async function previewRetouch(project, assets, tile, points, prompt, signal) {
  return requestImage(project, assets, 'retouch', { ...await retouchInputs(project, assets, tile, points, prompt), signal, previewOnly: true });
}
