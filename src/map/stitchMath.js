export const STITCH_VERSION = 4;
export function overlapBand(target, old) {
  const x=Math.max(target.x,old.x), y=Math.max(target.y,old.y), right=Math.min(target.x+target.width,old.x+old.width), bottom=Math.min(target.y+target.height,old.y+old.height);
  if(right<=x||bottom<=y)return null;
  const vertical=right-x<bottom-y, size=Math.max(1,Math.floor((vertical?right-x:bottom-y)/2));
  const positive=vertical ? target.x+target.width/2>old.x+old.width/2 : target.y+target.height/2>old.y+old.height/2;
  return {x:vertical?(positive?right-size:x):x,y:vertical?y:(positive?bottom-size:y),width:vertical?size:right-x,height:vertical?bottom-y:size,vertical,positive};
}
const luma=(d,i)=>.2126*d[i]+.7152*d[i+1]+.0722*d[i+2];
export function gradient(image,x,y){const {data:d,width:w,height:h}=image;const i=(y*w+x)*4;return Math.abs(luma(d,(y*w+Math.min(w-1,x+1))*4)-luma(d,i))+Math.abs(luma(d,(Math.min(h-1,y+1)*w+x)*4)-luma(d,i));}
export function bestSeam(reference,candidate,band,origin={x:0,y:0}) {
  const across=band.vertical?band.width:band.height, length=band.vertical?band.height:band.width;
  if(across<3||length<2)return null;
  const back=new Int8Array(across*length), points=[], cost=new Float64Array(across), next=new Float64Array(across);
  const at=(a,b)=>({x:band.x-origin.x+(band.vertical?a:b),y:band.y-origin.y+(band.vertical?b:a)});
  const patchError=(x,y)=>{let total=0,n=0;for(let dy=-2;dy<=2;dy+=2)for(let dx=-2;dx<=2;dx+=2){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=reference.width||yy>=reference.height)continue;const i=(yy*reference.width+xx)*4;if(reference.data[i+3]<250||candidate.data[i+3]<250)continue;for(let c=0;c<3;c++)total+=Math.abs(reference.data[i+c]-candidate.data[i+c])/3;n++;}return n?total/n:255;};
  // A single matching dark roof-edge pixel can hide two different silhouettes.
  // Compare its neighborhood and allow the path to reach the faithful old anchor.
  const energy=(a,b)=>{const {x,y}=at(a,b),i=(y*reference.width+x)*4;if(reference.data[i+3]<250||candidate.data[i+3]<250)return 1e5;let diff=0;for(let c=0;c<3;c++)diff+=Math.abs(reference.data[i+c]-candidate.data[i+c])/3;const distance=band.positive?a:across-1-a;return .5*diff+2*patchError(x,y)+.5*Math.abs(gradient(reference,x,y)-gradient(candidate,x,y))+.1*(gradient(reference,x,y)+gradient(candidate,x,y))+.01*distance;};
  for(let a=0;a<across;a++)cost[a]=energy(a,0);
  for(let b=1;b<length;b++){for(let a=0;a<across;a++){let best=a;for(let k=Math.max(0,a-1);k<=Math.min(across-1,a+1);k++)if(cost[k]<cost[best])best=k;back[b*across+a]=best-a;next[a]=cost[best]+energy(a,b);}cost.set(next);}
  let end=0;for(let a=1;a<across;a++)if(cost[a]<cost[end])end=a;
  const meanCost=cost[end]/length;
  for(let b=length-1;b>=0;b--){const p=at(end,b);points.push({x:p.x+origin.x,y:p.y+origin.y});end+=back[b*across+end];}points.reverse();
  const unsafeFraction=points.filter(p=>patchError(p.x-origin.x,p.y-origin.y)>22).length/points.length;
  return {points,meanCost,unsafeFraction,band};
}
export function stitchPixels(reference,candidate,bands,origin,feather=8) {
  const {width:w,height:h}=candidate, data=new Uint8ClampedArray(candidate.data), weights=new Float32Array(w*h); weights.fill(1);
  for(let n=0;n<w*h;n++)if(reference.coverage ? reference.coverage[n] : reference.data[n*4+3]>0)weights[n]=0;
  const paths=[];
  for(const band of bands){const seam=bestSeam(reference,candidate,band,origin);if(!seam)continue;paths.push(seam);
    const length=seam.points.length, across=band.vertical?band.width:band.height;
    for(let b=0;b<length;b++)for(let a=0;a<across;a++){
      const x=band.x-origin.x+(band.vertical?a:b),y=band.y-origin.y+(band.vertical?b:a),n=y*w+x;
      const position=band.vertical?x+origin.x:y+origin.y,cut=band.vertical?seam.points[b].x:seam.points[b].y;
      const hard=gradient(reference,x,y)>24||gradient(candidate,x,y)>24, f=hard?0:Math.min(32,Math.max(0,feather));
      const distance=(position-cut)*(band.positive?1:-1), edge=band.positive?a:across-1-a;
      let weight=f?Math.max(0,Math.min(1,.5+distance/(2*f))):distance>=0?1:0;
      // Exact old anchor/new boundary at the ends of the allowed overlap band.
      if(edge===0)weight=0;if(edge===across-1)weight=1;
      weights[n]=Math.max(weights[n],weight);
    }
  }
  for(let n=0;n<w*h;n++){const i=n*4,t=weights[n];if(t===0)data.set(reference.data.subarray(i,i+4),i);else if(t<1){const alpha=(reference.data[i+3]*(1-t)+candidate.data[i+3]*t);for(let c=0;c<3;c++)data[i+c]=alpha?Math.round((reference.data[i+c]*reference.data[i+3]*(1-t)+candidate.data[i+c]*candidate.data[i+3]*t)/alpha):0;data[i+3]=Math.round(alpha);}}
  return {width:w,height:h,data,paths};
}
export function alignmentQuality(reference,candidate,mask,colorMatch) {
  const w=reference.width,h=reference.height, samples=[];const step=Math.max(2,Math.ceil(Math.sqrt(w*h/3500)));
  for(let y=1;y<h-1;y+=step)for(let x=1;x<w-1;x+=step){const i=(y*w+x)*4;if(mask.data[i+3]===255&&reference.data[i+3]===255&&candidate.data[i+3]===255&&gradient(reference,x,y)>5)samples.push({x,y});}
  if(samples.length<48)return {reliable:false,reason:'对应纹理不足，无法可靠判断结构对齐',samples:samples.length};
  const error=(dx,dy)=>samples.reduce((sum,{x,y})=>sum+(x+dx<0||x+dx>=w||y+dy<0||y+dy>=h?80:Math.min(80,Math.abs(gradient(reference,x,y)-gradient(candidate,x+dx,y+dy)))),0)/samples.length;
  const zero=error(0,0);let best=zero,shift={x:0,y:0};for(let dy=-8;dy<=8;dy+=2)for(let dx=-8;dx<=8;dx+=2){const e=error(dx,dy);if(e<best){best=e;shift={x:dx,y:dy};}}
  const ratio=samples.reduce((s,{x,y})=>s+gradient(candidate,x,y),0)/Math.max(1,samples.reduce((s,{x,y})=>s+gradient(reference,x,y),0));
  const shifted=(Math.abs(shift.x)>=2||Math.abs(shift.y)>=2)&&best<zero*.75&&zero-best>2;
  const reliable=!shifted&&zero<18&&ratio>.55&&ratio<1.8&&colorMatch?.applied;
  return {reliable,reason:shifted?'检测到可能的结构平移':ratio<=.55||ratio>=1.8?'纹理密度或清晰度不一致':zero>=18?'重叠结构差异较大':!colorMatch?.applied?'颜色匹配不可靠':'对应区域结构一致',shift,gradientError:zero,textureRatio:ratio,samples:samples.length};
}
