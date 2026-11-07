import { intersection, tileRect } from './core.js';
import { assetImage, canvas, renderRect, storeCanvas } from './images.js';
import { matchSeamColors } from './seamColors.js';
import { STITCH_VERSION, overlapBand, stitchPixels, alignmentQuality } from './stitchMath.js';
import { opaqueTerrainPixels } from './terrainAlpha.js';
const snapshot=(t)=>Object.fromEntries(['id','x','y','px','py','width','height','originalId','groundId','objectsId','maskId','rawMaskId','kind','name'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]]));
export async function candidateFor(tile,assets) {
  if(tile.candidateAssetId)return assetImage(tile.candidateAssetId,assets);
  if(!tile.completedParts?.length||tile.completedParts.some(p=>!p.rawAssetId||!p.generation?.crop||!p.referenceRect))return null;
  const result=canvas(tile.width,tile.height),ctx=result.getContext('2d');
  for(const p of tile.completedParts){const raw=await assetImage(p.rawAssetId,assets),g=p.generation.crop;const aligned=canvas(p.referenceRect.width,p.referenceRect.height);aligned.getContext('2d').drawImage(raw,raw.width*g.x,raw.height*g.y,raw.width*g.width,raw.height*g.height,0,0,aligned.width,aligned.height);ctx.drawImage(aligned,p.offsetX??p.pad,p.offsetY??p.pad,p.rect.width,p.rect.height,p.rect.x,p.rect.y,p.rect.width,p.rect.height);}
  return result;
}
export async function processStitch(project,assets,tile,{feather=project.stitchFeather??8}={}) {
  const rect=tileRect(project,tile), neighbors=project.tiles.filter(t=>t.id!==tile.id&&intersection(tileRect(project,t),rect));
  const candidateImage=await candidateFor(tile,assets),candidate=canvas(rect.width,rect.height);candidate.getContext('2d').drawImage(candidateImage||await assetImage(tile.originalId,assets),0,0,rect.width,rect.height);
  if(/^gpt-image/.test(tile.model||'')||tile.completedParts?.some(p=>p.generation?.opaqueTerrain)){
    const ctx=candidate.getContext('2d'),d=ctx.getImageData(0,0,candidate.width,candidate.height);
    opaqueTerrainPixels(d.data);ctx.putImageData(d,0,0);
  }
  const candidateAssetId=await storeCanvas(candidate,assets);
  const before=await renderRect({...project,tiles:project.tiles.filter(t=>t.id!==tile.id)},assets,rect,'composite');
  const mask=canvas(rect.width,rect.height),mc=mask.getContext('2d'), coverage=new Uint8Array(rect.width*rect.height), bands=[];
  for(const n of neighbors){const r=tileRect(project,n),hit=intersection(r,rect);mc.fillStyle='#fff';mc.fillRect(hit.x-rect.x,hit.y-rect.y,hit.width,hit.height);for(let y=hit.y;y<hit.y+hit.height;y++)coverage.fill(1,(y-rect.y)*rect.width+hit.x-rect.x,(y-rect.y)*rect.width+hit.x-rect.x+hit.width);const band=overlapBand(rect,r);if(band)bands.push(band);}
  // Sampling mask: old anchor pixels white; both new area and editable bands transparent.
  for(const b of bands)mc.clearRect(b.x-rect.x,b.y-rect.y,b.width,b.height);
  const ctx=candidate.getContext('2d'),data=ctx.getImageData(0,0,rect.width,rect.height),ref=before.getContext('2d').getImageData(0,0,rect.width,rect.height),m=mc.getImageData(0,0,rect.width,rect.height);
  let colorMatch={applied:false,reason:'missing-original-candidate'};
  if(candidateImage)colorMatch=matchSeamColors(data,ref,m);
  const corrected={width:data.width,height:data.height,data:new Uint8ClampedArray(data.data)};
  if(colorMatch.applied)for(let i=0;i<data.data.length;i+=4)if(m.data[i+3]===255)for(let c=0;c<3;c++)corrected.data[i+c]=Math.round(Math.max(0,Math.min(255,data.data[i+c]*colorMatch.transforms[c].gain+colorMatch.transforms[c].offset)));
  const alignment=candidateImage?alignmentQuality(ref,corrected,m,colorMatch):{reliable:false,reason:'缺少原始候选，无法恢复真实重叠；保留旧图，不伪造选缝'};
  ref.coverage=coverage;
  const stitched=candidateImage?stitchPixels(ref,data,bands,rect,feather):{data:data.data,paths:[]};
  const rendered=canvas(rect.width,rect.height);rendered.getContext('2d').putImageData(new ImageData(stitched.data,rect.width,rect.height),0,0);
  const warnings=[];
  if(!candidateImage)warnings.push(alignment.reason);
  if(!colorMatch.applied)warnings.push('颜色匹配不可靠，未强制调整');
  if(!alignment.reliable)warnings.push(alignment.reason);
  if(!stitched.paths.length)warnings.push('没有可靠的可选拼接带');
  if(stitched.paths.some(p=>p.meanCost>38))warnings.push('接缝两侧差异过大，需要检查或重绘');
  if(stitched.paths.some(p=>p.unsafeFraction>.2))warnings.push('接缝附近结构不一致，自动选缝无法接齐；请框选完整物件进行跨图块修复');
  if ((tile.completedParts?.length || 0) > 1) warnings.push('多分段结果需要人工检查重复地标、物件比例和分段接缝');
  const generations=tile.completedParts?.map(p=>p.generation).filter(Boolean)||[];
  if(generations.some(g=>g.upscaled))warnings.push('新区域有效输出像素不足，对齐时发生放大');
  const diagnostics={colorMatch,alignment,warnings:[...new Set(warnings)],reliable:warnings.length===0,paths:stitched.paths,frames:(tile.completedParts||[]).filter(p=>p.generation).map(p=>{const g=p.generation;return ({effectiveWidth:Math.round(g.actualWidth*(g.crop?.width||1)*p.rect.width/(p.referenceRect?.width||g.sourceWidth)),effectiveHeight:Math.round(g.actualHeight*(g.crop?.height||1)*p.rect.height/(p.referenceRect?.height||g.sourceHeight)),referenceWidth:g.referenceWidth,referenceHeight:g.referenceHeight,actualWidth:g.actualWidth,actualHeight:g.actualHeight,upscaled:g.upscaled,crop:g.crop})})};
  const updates=[];
  for(const old of neighbors){if(!candidateImage)continue;const r=tileRect(project,old),patches=bands.map(b=>intersection(intersection(r,rect),b)).filter(Boolean);if(!patches.length)continue;
    const out=canvas(r.width,r.height),oc=out.getContext('2d');oc.drawImage(old.groundId||old.objectsId?await renderRect(project,assets,r,'composite'):await assetImage(old.originalId,assets),0,0,r.width,r.height);
    for(const hit of patches)oc.putImageData(rendered.getContext('2d').getImageData(hit.x-rect.x,hit.y-rect.y,hit.width,hit.height),hit.x-r.x,hit.y-r.y);
    updates.push({...old,originalId:await storeCanvas(out,assets),groundId:'',objectsId:'',maskId:'',rawMaskId:'',layerDraft:null,needsRelayer:Boolean(old.groundId||old.objectsId||old.layerDraft),stitchBackups:[...(old.stitchBackups||[]),snapshot(old)]});
  }
  const processed={...tile,originalId:await storeCanvas(rendered,assets),candidateAssetId:candidateImage?candidateAssetId:undefined,groundId:'',objectsId:'',maskId:'',rawMaskId:'',layerDraft:null,needsRelayer:Boolean(tile.groundId||tile.objectsId||tile.layerDraft),stitch:{version:STITCH_VERSION,feather,legacy:!candidateImage,diagnostics,sourceTiles:neighbors.map(snapshot),before:snapshot(tile)}};
  return {tile:processed,updates,diagnostics,rawTile:{...tile,originalId:candidateAssetId},feather};
}
export async function reprocessStitch(project,assets,tile,options={}) {
  // Preserve the original reference for repeatable local recalculation.
  const sources=tile.stitch?.sourceTiles;
  const reference={...project,tiles:project.tiles.filter(t=>t.id!==tile.id).map(t=>sources?.find(s=>s.id===t.id)||t)};
  return processStitch(reference,assets,tile,options);
}
