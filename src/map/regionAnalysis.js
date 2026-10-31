import { assetFor, mapBounds, mapGridGeometry, tileRect } from './core.js';
import { assetImage, canvas } from './images.js';
import { gridCellPolygon } from '../gridGeometry.js';

const MAX_EDGE = 2048;

function clipTile(ctx, rect, prior, bounds, scale) {
  const toCanvas = (x, y) => ({ x: (x - bounds.x) * scale, y: (y - bounds.y) * scale });
  const a = toCanvas(rect.x, rect.y), b = toCanvas(rect.x + rect.width, rect.y + rect.height);
  const path = new Path2D(); path.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  for (const previous of prior) {
    const left = Math.max(rect.x, previous.x), top = Math.max(rect.y, previous.y);
    const right = Math.min(rect.x + rect.width, previous.x + previous.width), bottom = Math.min(rect.y + rect.height, previous.y + previous.height);
    if (right <= left || bottom <= top) continue;
    const p = toCanvas(left, top), q = toCanvas(right, bottom);
    path.rect(p.x, p.y, q.x - p.x, q.y - p.y);
  }
  ctx.clip(path, 'evenodd');
}

export async function createRegionAnalysisImage(project, assets, task, gridLabels, gridMetrics) {
  const bounds = task === 'collision' ? mapGridGeometry(project) : mapBounds(project);
  const scale = Math.min(1, MAX_EDGE / Math.max(bounds.width, bounds.height));
  const target = canvas(bounds.width * scale, bounds.height * scale), ctx = target.getContext('2d');
  ctx.fillStyle = task === 'occlusion' ? '#ff00ff' : '#f4f6ef'; ctx.fillRect(0, 0, target.width, target.height);
  const prior = [];
  for (const tile of project.tiles) {
    const rect = tileRect(project, tile), left = Math.max(rect.x, bounds.x), top = Math.max(rect.y, bounds.y);
    const right = Math.min(rect.x + rect.width, bounds.x + bounds.width), bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
    if (right <= left || bottom <= top) { prior.push(rect); continue; }
    ctx.save(); clipTile(ctx, rect, prior, bounds, scale);
    const drawAsset = async (id) => {
      if (!id) return;
      const image = await assetImage(id, assets);
      ctx.drawImage(image, (rect.x - bounds.x) * scale, (rect.y - bounds.y) * scale, rect.width * scale, rect.height * scale);
    };
    if (task === 'collision') {
      await drawAsset(assetFor(tile, 'ground'));
      await drawAsset(assetFor(tile, 'objects'));
    } else {
      await drawAsset(tile.objectsId);
    }
    ctx.restore(); prior.push(rect);
  }

  if (task === 'collision') {
    ctx.save(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, 1.3 * scale); ctx.globalAlpha = .9;
    for (let row = 0; row < project.grid.height; row++) for (let col = 0; col < project.grid.width; col++) {
      const points = gridCellPolygon(project.grid, gridMetrics, col, row);
      ctx.beginPath(); points.forEach((point, index) => {
        const x = (bounds.x + point.x - bounds.x) * scale, y = (bounds.y + point.y - bounds.y) * scale;
        if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }); ctx.closePath(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const cellSize = Math.min(bounds.width / project.grid.width, bounds.height / project.grid.height) * scale;
    const fontSize = Math.max(7, Math.min(15, cellSize * .22));
    ctx.font = `600 ${fontSize}px ui-monospace, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const label of gridLabels) {
      const x = label.x * scale, y = label.y * scale, text = `${label.row},${label.col}`;
      const width = ctx.measureText(text).width + 4, height = fontSize + 2;
      ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.fillRect(x - width / 2, y - height / 2, width, height);
      ctx.fillStyle = '#17211a'; ctx.fillText(text, x, y);
    }
    ctx.restore();
  }
  const encoded = target.toDataURL('image/jpeg', .9).split(',')[1];
  return { imageBase64: encoded, imageMimeType: 'image/jpeg', imageWidth: target.width, imageHeight: target.height, bounds };
}
