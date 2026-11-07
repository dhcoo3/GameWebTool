import { matchSeamColors } from './seamColors.js';
import { intersection, polygonBounds, tileRect } from './core.js';
import { assetImage, canvas, renderRect, requestImage, storeCanvas, restorePixels } from './images.js';

export const SEAM_PROMPT = 'Repair ONLY local discontinuities across the selected map seam using the smallest possible changes. Reconnect existing tree trunks and branches, road edges, fences, masonry and silhouettes. Preserve EVERY distinct building and prop, its identity, footprint, position and scale. Never merge two buildings, remove a building, relocate a doorway, replace a house or clear its props. Where two separate houses are visible, keep BOTH separate; repair only their damaged edges. Match endpoints on BOTH sides and their width, direction, material, palette and lighting. Edit only the masked area, leaving its already coherent content intact. Preserve all surrounding pixels and exact camera and framing. Keep original exposure, white balance, saturation and contrast. No darkening, color grading, vignette or localized tint. Do not add objects, duplicate structures, blur the seam, or redesign the map.';
export const expansionStamp = (p) => JSON.stringify([8, p.expansionDescription || '', p.stitchFeather ?? 8, p.expansionContextEnabled === true, p.provider, p.resolution, p.subdivisions, p.prompt, p.negativePrompt, p.tileWidth, p.tileHeight]);
export const seamStamp = (p) => JSON.stringify([p.visibility, p.overlapX, p.overlapY, p.tiles.map((t) => [t.id, tileRect(p, t), t.originalId, t.groundId, t.objectsId])]);

export async function seamInputs(project, assets, points) {
  if (!Array.isArray(points) || points.length !== 4 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('请框选跨越接缝的矩形区域。');
  const selection = polygonBounds(points);
  const touched = project.tiles.filter((t) => intersection(tileRect(project, t), selection));
  if (touched.length < 2) throw new Error('选区需要跨越至少两张图块的接缝。');
  const rect = { x: selection.x - 128, y: selection.y - 128, width: selection.width + 256, height: selection.height + 256 };
  if (rect.width > 8192 || rect.height > 8192 || rect.width * rect.height > 24_000_000) throw new Error('修复范围过大，请分段框选接缝。');
  const owners = new Set();
  for (let y = selection.y; y < selection.y + selection.height; y++) for (let x = selection.x; x < selection.x + selection.width; x++) {
    const owner = touched.find((t) => { const r = tileRect(project, t); return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height; });
    if (owner) owners.add(owner.id);
    if (owners.size > 1) break;
  }
  if (owners.size < 2) throw new Error('选区只覆盖一张图块的可见内容，请跨过实际显示的接缝。');
  const image = await renderRect(project, assets, rect, 'composite');
  const mask = canvas(rect.width, rect.height), mc = mask.getContext('2d');
  mc.fillStyle = '#fff'; mc.fillRect(0, 0, mask.width, mask.height);
  const pixels = mc.getImageData(0, 0, mask.width, mask.height);
  const rectangles = touched.map((t) => tileRect(project, t));
  // Feather only INSIDE the selection. Outside coverage/selection remains fully protected.
  for (let y = 0; y < selection.height; y++) for (let x = 0; x < selection.width; x++) {
    const wx = selection.x + x, wy = selection.y + y;
    if (!rectangles.some((r) => wx >= r.x && wy >= r.y && wx < r.x + r.width && wy < r.y + r.height)) continue;
    const weight = Math.min(1, (Math.min(x, y, selection.width - 1 - x, selection.height - 1 - y) + 1) / 4);
    pixels.data[((y + 128) * mask.width + x + 128) * 4 + 3] = Math.round(255 * (1 - weight));
  }
  mc.putImageData(pixels, 0, 0);
  return { image, mask, selection, rect, touched };
}

export async function repairSeam(project, assets, points, { signal, fetcher } = {}) {
  const input = await seamInputs(project, assets, points);
  const result = await requestImage(project, assets, 'retouch', { ...input, prompt: SEAM_PROMPT, signal, fetcher, beforeRestore: (output) => correctCanvas(output, input), preserveRaw: true, requestTag: '跨图块接缝修复' });
  return finishSeam(project, assets, input, result);
}

function correctCanvas(output, input) {
  const ctx = output.getContext('2d'), data = ctx.getImageData(0, 0, output.width, output.height);
  const stats = matchSeamColors(data, input.image.getContext('2d').getImageData(0, 0, output.width, output.height), input.mask.getContext('2d').getImageData(0, 0, output.width, output.height));
  ctx.putImageData(data, 0, 0); return stats;
}

// Reuse the saved provider image for pending previews, without another AI call.
export async function recolorSeam(project, assets, pending) {
  const saved = pending.tiles?.[0]?.seamHistory?.at(-1);
  if (!saved?.rawAssetId || !saved.generation?.crop) throw new Error('此预览缺少原始生成图，无法本地校色。请丢弃后重新生成修复。');
  const s = pending.selection, input = await seamInputs(project, assets, [{ x:s.x,y:s.y },{ x:s.x+s.width,y:s.y },{ x:s.x+s.width,y:s.y+s.height },{ x:s.x,y:s.y+s.height }]);
  const raw = await assetImage(saved.rawAssetId, assets), out = canvas(input.image.width, input.image.height), crop = saved.generation.crop;
  out.getContext('2d').drawImage(raw, raw.width*crop.x, raw.height*crop.y, raw.width*crop.width, raw.height*crop.height, 0,0,out.width,out.height);
  const stats = correctCanvas(out, input);
  return finishSeam(project, assets, input, { canvas: restorePixels(out,input.image,input.mask), rawAssetId:saved.rawAssetId, generation:saved.generation, postprocess:stats });
}

async function finishSeam(project, assets, input, result) {
  const afterAssetId = await storeCanvas(result.canvas, assets), beforeAssetId = await storeCanvas(input.image, assets);
  const tiles = [];
  for (const tile of input.touched) {
    const r = tileRect(project, tile), hit = intersection(r, input.selection);
    const output = canvas(r.width, r.height), ctx = output.getContext('2d');
    // Flatten the currently visible layers before invalidating them, so no outside
    // scene pixels revert to an older original image after accepting the repair.
    if (tile.groundId || tile.objectsId) ctx.drawImage(await renderRect(project, assets, r, 'composite'), 0, 0);
    else ctx.drawImage(await assetImage(tile.originalId, assets), 0, 0, r.width, r.height);
    // Copy identical world pixels into every overlap, including alpha, without resampling.
    const patch = result.canvas.getContext('2d').getImageData(hit.x - input.rect.x, hit.y - input.rect.y, hit.width, hit.height);
    ctx.putImageData(patch, hit.x - r.x, hit.y - r.y);
    const backup = { originalId: tile.originalId, groundId: tile.groundId, objectsId: tile.objectsId, maskId: tile.maskId, rawMaskId: tile.rawMaskId, layerDraft: tile.layerDraft, layerMode: tile.layerMode };
    tiles.push({ ...tile, originalId: await storeCanvas(output, assets), groundId: '', objectsId: '', maskId: '', rawMaskId: '', layerDraft: null,
      completedParts: [], needsRelayer: Boolean(tile.groundId || tile.objectsId || tile.layerDraft),
      seamHistory: [...(tile.seamHistory || []), { ...backup, repairedAt: Date.now(), selection: input.selection, rawAssetId: result.rawAssetId, generation: result.generation, colorMatch: result.postprocess }] });
  }
  return { tiles, beforeAssetId, afterAssetId, rect: input.rect, selection: input.selection, colorMatch: result.postprocess, previewKind: 'seam', mode: 'multi-replace', seamStamp: seamStamp(project) };
}
