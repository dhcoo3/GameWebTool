const fs = require('fs');
const path = require('path');
const assert = require('assert');
const sharp = require('/Users/ysj/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const SOURCE = '/Users/ysj/Documents/Fanstasy/GameTopRouge/Client/GameTopRouge/Assets/SmallScaleInt/TopDown 2D pixel Characters pack 1/Spritesheets/1Knight/Idle.png';
const OUT = __dirname;
// Hand-placed equipment guides in original frame coordinates, in source row order.
// Each guide follows its own original-image patch, rather than moving the sprite.
const rigs = [
 {head:[69,52,6,5], shoulders:[[[52,58],[57,61],[63,61]],[[74,56],[77,58]]], waist:[[62,67],[67,68],[71,67]], cloth:[[64,69],[69,69],[67,74],[62,74]], knees:[[[52,83],[56,84]],[[78,75],[81,75]]], wrists:[[[53,70],[55,72]],[[79,60],[81,61]]], shield:null, visor:[[67,52],[72,53]]},
 {head:[66,53,5,5], shoulders:[[[54,57],[58,60],[62,60]],[[72,59],[76,60],[78,58]]], waist:[[62,66],[67,67],[71,66]], cloth:[[64,69],[69,70],[68,74],[64,73]], knees:[[[51,79],[55,80]],[[75,82],[79,83]]], wrists:[[[49,65],[51,65]]], shield:[[76,67],[81,63],[81,75],[78,78],[76,76]], visor:[[65,53],[69,54]]},
 {head:[59,52,5,6], shoulders:[[[61,61],[65,63],[69,62]]], waist:[[57,64],[61,65]], cloth:[[55,65],[59,65],[59,70],[55,70]], knees:[[[63,86],[66,86]]], wrists:[[[54,75],[56,76]]], shield:[[58,67],[70,67],[71,76],[66,82],[60,79]], visor:[[58,53],[61,52]]},
 {head:[58,50,5,5], shoulders:[[[58,61],[62,63],[65,62]]], waist:[[64,66],[67,66]], cloth:[[65,68],[69,69],[67,74],[64,74]], knees:[[[61,86],[65,86]],[[70,76],[73,75]]], wrists:[[[66,65],[68,66]]], shield:[[46,61],[51,64],[57,65],[57,75],[53,79],[47,75]], visor:[[55,51],[59,52]]},
 {head:[58,47,5,5], shoulders:[[[62,53],[66,55],[70,54]],[[49,58],[53,60],[57,59]]], waist:[[59,64],[63,65],[66,63]], cloth:[[60,66],[64,66],[64,71],[60,71]], knees:[[[49,79],[53,80]],[[74,76],[76,77]]], wrists:[[[48,60],[50,61]],[[71,55],[73,56]]], shield:null, visor:null},
 {head:[64,45,5,5], shoulders:[[[51,55],[55,57],[59,56]],[[68,55],[72,57],[76,55]]], waist:[[60,63],[65,65],[69,64]], cloth:[[62,66],[67,66],[67,71],[63,70]], knees:[[[51,78],[54,79]],[[75,80],[78,80]]], wrists:[[[49,58],[51,59]],[[76,61],[78,61]]], shield:null, visor:null},
 {head:[65,47,4,5], shoulders:[[[59,54],[62,57],[64,57]],[[66,58],[70,61],[73,59]]], waist:[[63,65],[67,67],[70,66]], cloth:[[63,68],[67,69],[67,74],[63,73]], knees:[[[68,84],[72,84]]], wrists:[[[74,67],[78,67]]], shield:null, visor:null},
 {head:[64,49,5,5], shoulders:[[[57,60],[61,63],[65,62]],[[69,56],[72,58],[75,57]]], waist:[[61,66],[65,68],[68,67]], cloth:[[62,69],[67,70],[66,75],[62,74]], knees:[[[57,88],[61,88]],[[69,78],[72,78]]], wrists:[[[65,73],[68,73]],[[72,60],[74,61]]], shield:null, visor:[[65,50],[68,50]]},
];
const lum = p => .2126*p[0]+.7152*p[1]+.0722*p[2];
const solid = p => p[3]>245 && Math.max(p[0],p[1],p[2])>35;
const steel = p => solid(p) && p[0]-p[2]<23 && p[1]-p[2]<14 && lum(p)>58;
const clamp = x => Math.max(0,Math.min(255,Math.round(x)));
function pixel(b,x,y){x=Math.max(0,Math.min(127,x));y=Math.max(0,Math.min(127,y));let i=(y*128+x)*4;return b.subarray(i,i+4);}
function inside(x,y,poly){let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>y)!=(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
function distance(x,y,points){let d=Infinity;for(let k=1;k<points.length;k++){let [ax,ay]=points[k-1],[bx,by]=points[k],vx=bx-ax,vy=by-ay,t=Math.max(0,Math.min(1,((x-ax)*vx+(y-ay)*vy)/(vx*vx+vy*vy||1)));d=Math.min(d,Math.hypot(x-ax-t*vx,y-ay-t*vy));}return d;}
function center(points){return points.reduce((a,p)=>[a[0]+p[0]/points.length,a[1]+p[1]/points.length],[0,0]);}
function track(ref,frame,points){const [cx,cy]=center(points).map(Math.round);let best=[0,0],err=Infinity;for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){let e=0,n=0;for(let y=-6;y<=6;y++)for(let x=-6;x<=6;x++){let a=pixel(ref,cx+x,cy+y),b=pixel(frame,cx+x+dx,cy+y+dy);if(!solid(a))continue;let w=1/(1+(x*x+y*y)/30);e+=w*(Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])+Math.abs(a[2]-b[2])+Math.abs(a[3]-b[3])*.8);n+=w;}e=e/(n||1)+.9*(dx*dx+dy*dy);if(e<err){err=e;best=[dx,dy];}}return {points:points.map(p=>[p[0]+best[0],p[1]+best[1]]),offset:best};}
function ramp(t,stops){t=Math.max(0,Math.min(1,t));let s=t*(stops.length-1),i=Math.min(stops.length-2,Math.floor(s)),f=s-i;return stops[i].map((v,k)=>clamp(v*(1-f)+stops[i+1][k]*f));}
const metal=[[31,36,45],[62,72,86],[113,131,147],[176,190,198],[228,230,220]];
const gold=[[57,37,22],[114,75,31],[186,137,61],[236,200,115]];
const red=[[39,14,23],[76,23,36],[121,37,49],[161,58,62]];
async function main(){
 const sourceBytes=fs.readFileSync(SOURCE);const crypto=require('crypto');const sourceHash=crypto.createHash('sha256').update(sourceBytes).digest('hex');
 const {data,info}=await sharp(sourceBytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(info.width,1920);assert.equal(info.height,1024);
 const output=Buffer.from(data), frames=[], report={source:SOURCE,sourceSha256:sourceHash,width:1920,height:1024,frameWidth:128,frameHeight:128,directions:8,framesPerDirection:15,alphaDifferences:0,shadowPixelDifferences:0,changedBodyPixels:0,frames:[],previewFps:10};
 for(let row=0;row<8;row++){
  const originals=[];for(let col=0;col<15;col++)originals.push(await sharp(sourceBytes).extract({left:col*128,top:row*128,width:128,height:128}).raw().toBuffer());
  const ref=originals[0],rig=rigs[row],rowFrames=[];
  for(let col=0;col<15;col++){
   const frame=originals[col],result=Buffer.from(frame),tracks=[];
   const follow=points=>{let t=track(ref,frame,points);tracks.push(t.offset);return t.points;};
   const shoulder=rig.shoulders.map(follow),knees=rig.knees.map(follow),wrists=rig.wrists.map(follow),waist=follow(rig.waist),cloth=follow(rig.cloth),shield=rig.shield?follow(rig.shield):null;
   const hc=follow([[rig.head[0],rig.head[1]]])[0],head=[...hc,rig.head[2],rig.head[3]],visor=rig.visor?rig.visor.map(p=>[p[0]+hc[0]-rig.head[0],p[1]+hc[1]-rig.head[1]]):null;
   let changed=0,alphaDiff=0,shadowDiff=0;
   for(let y=0;y<128;y++)for(let x=0;x<128;x++){
    const i=(y*128+x)*4,p=frame.subarray(i,i+4);if(!solid(p))continue;
    let color=[p[0],p[1],p[2]],l=lum(p),isSteel=steel(p),inHead=((x-head[0])/head[2])**2+((y-head[1])/head[3])**2<=1;
    // Retain the source's lighting planes. Convert its dull warm gray to cool steel.
    if(isSteel){let t=(l-47)/155;color=ramp(t,metal);}
    if(inHead&&l>48){color=ramp((l-56)/145,metal);if(visor&&distance(x,y,visor)<.65)color=[28,30,35];}
    // Existing brown straps become darker, warmer leather; joint blacks remain intact.
    if(!isSteel&&!inHead&&p[0]-p[2]>15&&l>24&&l<100)color=[clamp(p[0]*.91),clamp(p[1]*.78),clamp(p[2]*.70)];
    if(inside(x+.5,y+.5,cloth)&&isSteel){let fold=Math.abs(x-center(cloth)[0])<.9?.13:0;color=ramp((l-55)/110-fold,red);}
    if(isSteel&&shoulder.some(s=>distance(x,y,s)<.65))color=ramp((l-45)/150,gold);
    // One inset dark seam makes the original shoulder shape read as layered plate.
    if(isSteel&&shoulder.some(s=>distance(x,y-2,s)<.48))color=color.map(v=>clamp(v*.61));
    if(isSteel&&(knees.some(s=>distance(x,y,s)<.55)||wrists.some(s=>distance(x,y,s)<.55)))color=ramp((l-42)/155,gold);
    if(distance(x,y,waist)<.7&&l>32)color=ramp((l-20)/160,gold);
    if(shield&&inside(x+.5,y+.5,shield)&&isSteel){
      color=ramp((l-60)/110,red);
      if(distance(x,y,[...shield,shield[0]])<.95)color=ramp((l-40)/150,gold);
      const c=center(shield);if((Math.abs(x-c[0])<.65&&Math.abs(y-c[1])<3)||(Math.abs(y-c[1])<.6&&Math.abs(x-c[0])<2))color=ramp((l-20)/150,gold);
    }
    // A small gold crest contained inside the original helmet, never expanding it.
    if(inHead&&isSteel&&Math.abs(y-(head[1]-head[3]+2))<.45&&Math.abs(x-head[0])<head[2]-1)color=ramp((l-45)/145,gold);
    result[i]=color[0];result[i+1]=color[1];result[i+2]=color[2];
   }
   for(let i=0;i<frame.length;i+=4){if(result[i+3]!==frame[i+3])alphaDiff++;if(!solid(frame.subarray(i,i+4))&&!result.subarray(i,i+4).equals(frame.subarray(i,i+4)))shadowDiff++;if(!result.subarray(i,i+4).equals(frame.subarray(i,i+4)))changed++;let x=(i/4)%128,y=Math.floor(i/4/128),o=((row*128+y)*1920+col*128+x)*4;result.copy(output,o,i,i+4);}
   report.alphaDifferences+=alphaDiff;report.shadowPixelDifferences+=shadowDiff;report.changedBodyPixels+=changed;report.frames.push({row:row+1,column:col+1,changedBodyPixels:changed,alphaDifferences:alphaDiff,shadowPixelDifferences:shadowDiff,trackedOffsets:tracks});rowFrames.push(result);
  }
  frames.push(rowFrames);
 }
 assert.equal(report.alphaDifferences,0);assert.equal(report.shadowPixelDifferences,0);assert(report.frames.every(f=>f.changedBodyPixels>0));
 await sharp(output,{raw:{width:1920,height:1024,channels:4}}).png().toFile(path.join(OUT,'Idle-Elite.png'));
 const comps=[],tightComps=[];
 for(let r=0;r<8;r++){
  for(let side=0;side<2;side++){
   const b=side?frames[r][0]:await sharp(sourceBytes).extract({left:0,top:r*128,width:128,height:128}).raw().toBuffer();
   comps.push({input:await sharp(b,{raw:{width:128,height:128,channels:4}}).resize(512,512,{kernel:'nearest'}).png().toBuffer(),left:(r%4)*1024+side*512,top:Math.floor(r/4)*512});
   tightComps.push({input:await sharp(b,{raw:{width:128,height:128,channels:4}}).extract({left:32,top:28,width:72,height:84}).resize(288,336,{kernel:'nearest'}).png().toBuffer(),left:(r%2)*576+side*288,top:Math.floor(r/2)*360+24});
  }
  const opaqueFrames=await Promise.all(frames[r].map(b=>sharp(b,{raw:{width:128,height:128,channels:4}}).resize(512,512,{kernel:'nearest'}).flatten({background:'#737a82'}).ensureAlpha().raw().toBuffer()));
  const stack=Buffer.concat(opaqueFrames);
  await sharp(stack,{raw:{width:512,height:512*15,channels:4,pageHeight:512}}).gif({delay:Array(15).fill(100),loop:0,effort:7,dither:0,keepDuplicateFrames:true}).toFile(path.join(OUT,`direction-${r+1}-4x.gif`));
 }
 await sharp({create:{width:4096,height:1024,channels:4,background:'#737a82'}}).composite(comps).png().toFile(path.join(OUT,'eight-directions-comparison-4x.png'));
 let labels='<svg width="1152" height="1440">';for(let r=0;r<8;r++){const x=(r%2)*576,y=Math.floor(r/2)*360;labels+=`<text x="${x+18}" y="${y+19}" fill="#ffffff" font-family="sans-serif" font-size="14">${r+1} — ORIGINAL</text><text x="${x+306}" y="${y+19}" fill="#ffffff" font-family="sans-serif" font-size="14">ELITE</text>`;}labels+='</svg>';
 await sharp({create:{width:1152,height:1440,channels:4,background:'#737a82'}}).composite([...tightComps,{input:Buffer.from(labels)}]).png().toFile(path.join(OUT,'equipment-detail-comparison-4x.png'));
 // Eight directions animate simultaneously; use an opaque backdrop for reliable GIF shadows.
 const animated=[];
 for(let c=0;c<15;c++){
  const pieces=[];for(let r=0;r<8;r++)pieces.push({input:await sharp(frames[r][c],{raw:{width:128,height:128,channels:4}}).resize(256,256,{kernel:'nearest'}).png().toBuffer(),left:(r%4)*256,top:Math.floor(r/4)*256});
  animated.push(await sharp({create:{width:1024,height:512,channels:4,background:'#737a82'}}).composite(pieces).raw().toBuffer());
 }
 await sharp(Buffer.concat(animated),{raw:{width:1024,height:512*15,channels:4,pageHeight:512}}).gif({delay:Array(15).fill(100),loop:0,effort:7,dither:0}).toFile(path.join(OUT,'all-directions-preview.gif'));
 // Human-readable audit data; equality of alpha guarantees original silhouette at every threshold.
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex'),sourceHash);
 const saved=await sharp(path.join(OUT,'Idle-Elite.png')).ensureAlpha().raw().toBuffer();assert(saved.equals(output));
 for(let r=0;r<8;r++){let meta=await sharp(path.join(OUT,`direction-${r+1}-4x.gif`),{animated:true}).metadata();assert.equal(meta.pages,15);assert.equal(meta.pageHeight,512);}
 fs.writeFileSync(path.join(OUT,'validation.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({output:OUT,alphaDifferences:report.alphaDifferences,shadowPixelDifferences:report.shadowPixelDifferences,changedBodyPixels:report.changedBodyPixels,frames:report.frames.length}));
}
main().catch(e=>{console.error(e);process.exit(1);});
