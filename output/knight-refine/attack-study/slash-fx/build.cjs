const fs=require('fs'),path=require('path'),assert=require('assert'),crypto=require('crypto');
const sharp=require('/Users/ysj/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const dir=__dirname,src=path.dirname(dir),names=['01-guard','02-windup','03-slash','04-recovery'];
function bounds(b){let z=[128,128,-1,-1];for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(b[(y*128+x)*4+3])z=[Math.min(z[0],x),Math.min(z[1],y),Math.max(z[2],x),Math.max(z[3],y)];return z[2]<0?null:z;}
function distance(x,y,a,b){const vx=b[0]-a[0],vy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*vx+(y-a[1])*vy)/(vx*vx+vy*vy)));return Math.hypot(x-a[0]-t*vx,y-a[1]-t*vy);}
(async()=>{let review=[],animation=[],sprites=[],fxs=[],report={frameSize:[128,128],safeInset:4,previewDelaysMs:[500,240,100,300],frames:[]};
for(let k=0;k<4;k++){
const file=path.join(src,names[k]+'.png'),original=fs.readFileSync(file),hash=crypto.createHash('sha256').update(original).digest('hex');const body=await sharp(original).ensureAlpha().raw().toBuffer();const fx=Buffer.alloc(128*128*4);
for(let y=4;y<124;y++)for(let x=4;x<124;x++){
const i=(y*128+x)*4;let a=0,c=[156,204,229];
if(k===1){if(distance(x+.5,y+.5,[58,40],[69,36])<.65&&body[i]>135&&body[i+1]>130){a=160;c=[234,247,252];}}
if(k===2){const dx=x+.5-65,dy=(y+.5-65)/.9,r=Math.hypot(dx,dy),theta=Math.atan2(dy,dx)*180/Math.PI,t=(theta+66)/105;
if(t>=0&&t<=1){const outer=38,thickness=.4+10*t*t;const depth=outer-r;if(depth>=0&&depth<thickness){a=depth<1? (t>.65?224:t>.3?128:64):depth<3?(t>.6?144:64):depth<6?80:40;if(depth<1&&t>.7)c=[229,247,255];}}
if(distance(x+.5,y+.5,[79,76],[94,86])<.72){a=240;c=[240,251,255];}
}
if(k===3){const dx=x+.5-64,dy=(y+.5-62)/.9,r=Math.hypot(dx,dy),theta=Math.atan2(dy,dx)*180/Math.PI,t=(theta-19)/34;if(t>=0&&t<=1&&r<32&&r>32-(1+3*(1-t))){a=r>31?96:40;c=[174,213,231];}}
// FX sits behind shield, armor and hand. Only the windup's blade glint is in front.
if(k!==1&&body[i+3]>32)a=0;
if(a){fx[i]=c[0];fx[i+1]=c[1];fx[i+2]=c[2];fx[i+3]=a;}
}
const fxPng=await sharp(fx,{raw:{width:128,height:128,channels:4}}).png().toBuffer();fs.writeFileSync(path.join(dir,names[k]+'-fx.png'),fxPng);fxs.push(fxPng);
const combined=await sharp(original).composite([{input:fxPng}]).png().toBuffer();fs.writeFileSync(path.join(dir,names[k]+'-combined.png'),combined);sprites.push(combined);
const combinedRaw=await sharp(combined).ensureAlpha().raw().toBuffer(),b=bounds(combinedRaw);assert(b[0]>=4&&b[1]>=4&&b[2]<=123&&b[3]<=123);
let overlaps=0;for(let i=0;i<fx.length;i+=4)if(fx[i+3]&&body[i+3]>32&&k!==1)overlaps++;assert.equal(overlaps,0);
report.frames.push({name:names[k],fxBounds:bounds(fx),combinedBounds:b,fxPixels:fx.filter((v,i)=>i%4===3&&v>0).length,unwantedBodyOverlaps:overlaps,sourceSha256:hash});assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hash);
for(let row=0;row<3;row++){const p=row===0?original:row===1?fxPng:combined;const big=await sharp(p).resize(512,512,{kernel:'nearest'}).png().toBuffer();const label=Buffer.from(`<svg width="512" height="512"><rect x="16" y="16" width="480" height="480" fill="none" stroke="#9daead" stroke-dasharray="7 7"/><text x="24" y="38" fill="#ffffff" font-family="sans-serif" font-size="17">${names[k]} / ${['ORIGINAL','FX ONLY','COMBINED'][row]}</text></svg>`);review.push({input:await sharp(big).composite([{input:label}]).png().toBuffer(),left:k*512,top:row*512});}
animation.push(await sharp(combined).resize(512,512,{kernel:'nearest'}).flatten({background:'#505b69'}).ensureAlpha().raw().toBuffer());
}
assert.equal(report.frames[0].fxPixels,0);assert(report.frames[2].fxPixels>report.frames[3].fxPixels);
await sharp({create:{width:2048,height:1536,channels:4,background:'#505b69'}}).composite(review).png().toFile(path.join(dir,'slash-review-4x.png'));
for(const [name,parts] of [['combined-keyframes.png',sprites],['fx-keyframes.png',fxs]])await sharp({create:{width:512,height:128,channels:4,background:'#00000000'}}).composite(parts.map((input,k)=>({input,left:k*128,top:0}))).png().toFile(path.join(dir,name));
await sharp(Buffer.concat(animation),{raw:{width:512,height:2048,channels:4,pageHeight:512}}).gif({delay:report.previewDelaysMs,loop:0,dither:0,keepDuplicateFrames:true}).toFile(path.join(dir,'keyframe-preview.gif'));
const meta=await sharp(path.join(dir,'keyframe-preview.gif'),{animated:true}).metadata();assert.equal(meta.pages,4);assert.deepEqual(meta.delay,report.previewDelaysMs);
fs.writeFileSync(path.join(dir,'validation.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(dir,'README.md'),'# 斜劈银白刀光试作\n\n所有独立帧均为128×128透明PNG，人物原稿保持不变。\n\n- *-fx.png：刀光独立层，已处理人物遮挡；置于对应原稿之上，以正常透明混合合成。01-guard-fx.png为空白透明帧，属于预期。\n- *-combined.png：对应合成帧。\n- fx-keyframes.png、combined-keyframes.png：按待机、蓄力、斜劈、收招排列的4列图集。\n- slash-review-4x.png：上原图、中刀光、下合成，四倍最近邻放大。\n- keyframe-preview.gif：四关键姿势时序检查，不是完整攻击动画。展示时长500/240/100/300毫秒。\n- validation.json：边界、遮挡与原文件校验。\n\n刀光采用离散像素轮廓及透明度层级，无模糊滤镜。未制作补间或其他方向，未修改Unity项目。\n');console.log(JSON.stringify(report));
})();
