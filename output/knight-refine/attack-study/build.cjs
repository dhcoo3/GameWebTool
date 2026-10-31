const fs=require('fs'),path=require('path'),assert=require('assert');
const sharp=require('/Users/ysj/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const out=__dirname,source='/Users/ysj/.codex/generated_images/01a1877d-bd61-7933-8e2b-b7bbf31503bc/exec-e514cc6d-9e83-4782-9c96-a679c1fa7136.png',design='/Users/ysj/.codex/generated_images/01a1877d-bd61-7933-8e2b-b7bbf31503bc/exec-87dd35a7-79b2-4475-b516-e85ed01b9c35.png';
(async()=>{
fs.copyFileSync(source,path.join(out,'pose-reference-source.png'));fs.copyFileSync(design,path.join(out,'character-design-source.png'));
const scale=.111,edges=[0,541,1071,1678,2172],centers=[283,827,1379,1926],names=['01-guard','02-windup','03-slash','04-recovery'],tips=[[430,176],[884,74],[1656,536],[2136,497]],report={width:128,height:128,commonScale:scale,groundReference:[64,101],safeInset:4,frames:[],limitations:'AI concept keyframes: projected equipment shapes may vary; not production inbetweens or eight-direction validation.'};const sheets=[],silhouettes=[],frames=[];
for(let k=0;k<4;k++){
const width=edges[k+1]-edges[k],left=64-Math.round((centers[k]-edges[k])*scale),top=28;
const sprite=await sharp(source).extract({left:edges[k],top:0,width,height:724}).resize(Math.round(width*scale),Math.round(724*scale),{kernel:'nearest'}).png().toBuffer();
const shadow=Buffer.from('<svg width="128" height="128"><ellipse cx="64" cy="100" rx="23" ry="4" fill="#10141e" fill-opacity=".25"/></svg>');
const frame=await sharp({create:{width:128,height:128,channels:4,background:'#00000000'}}).composite([{input:shadow},{input:sprite,left,top}]).png().toBuffer();frames.push(frame);fs.writeFileSync(path.join(out,names[k]+'.png'),frame);
const {data}=await sharp(frame).raw().toBuffer({resolveWithObject:true});let bounds=[128,128,-1,-1];for(let y=0;y<128;y++)for(let x=0;x<128;x++){let i=(y*128+x)*4;if(data[i+3]){bounds=[Math.min(bounds[0],x),Math.min(bounds[1],y),Math.max(bounds[2],x),Math.max(bounds[3],y)];data[i]=data[i+1]=data[i+2]=12;}}
assert(bounds[0]>=4&&bounds[1]>=4&&bounds[2]<=123&&bounds[3]<=123);
const sil=await sharp(data,{raw:{width:128,height:128,channels:4}}).png().toBuffer();fs.writeFileSync(path.join(out,names[k]+'-silhouette.png'),sil);
const tip=[left+Math.round((tips[k][0]-edges[k])*scale),top+Math.round(tips[k][1]*scale)];report.frames.push({name:names[k],bounds,swordTip:tip,groundY:101});
for(let row=0;row<2;row++){const buffer=row?sil:frame;const big=await sharp(buffer).resize(512,512,{kernel:'nearest'}).png().toBuffer();const svg=Buffer.from(`<svg width="512" height="512"><rect x="16" y="16" width="480" height="480" fill="none" stroke="#9bb6aa" stroke-dasharray="8 6"/><path d="M16 404H496" stroke="#65c9df" stroke-dasharray="6 6"/><path d="M248 404h16M256 396v16" stroke="#65c9df"/><circle cx="${tip[0]*4+2}" cy="${tip[1]*4+2}" r="7" fill="none" stroke="#ffc66d"/><text x="24" y="36" fill="white" font-family="sans-serif" font-size="16">${names[k]}</text></svg>`);const marked=await sharp(big).composite([{input:svg}]).png().toBuffer();sheets.push({input:marked,left:k*512,top:row*512});}
}
await sharp({create:{width:2048,height:1024,channels:4,background:'#656e7a'}}).composite(sheets).png().toFile(path.join(out,'four-poses-review-4x.png'));
await sharp({create:{width:512,height:128,channels:4,background:'#00000000'}}).composite(frames.map((input,k)=>({input,left:k*128,top:0}))).png().toFile(path.join(out,'four-keyframes.png'));
fs.copyFileSync(path.join(out,'01-guard.png'),path.join(out,'character-design-128.png'));
const overview=Buffer.from(`<svg width="512" height="512"><path d="M0 404H512" stroke="#65c9df"/>${report.frames.map((f,k)=>`<circle cx="${f.swordTip[0]*4}" cy="${f.swordTip[1]*4}" r="6" fill="#ffc66d"/><text x="${f.swordTip[0]*4+8}" y="${f.swordTip[1]*4}" fill="white" font-size="16">${k+1}</text>`).join('')}<polyline points="${report.frames.map(f=>f.swordTip.map(v=>v*4).join(',')).join(' ')}" stroke="#ffc66d" fill="none" stroke-dasharray="7 6"/><text x="20" y="28" fill="white" font-size="16">KEYFRAME TIP POSITIONS — NOT INTERPOLATED ARC</text></svg>`);
await sharp({create:{width:512,height:512,channels:4,background:'#656e7a'}}).composite([{input:await sharp(frames[0]).resize(512,512,{kernel:'nearest'}).png().toBuffer()},{input:overview}]).png().toFile(path.join(out,'sword-tip-guide.png'));
fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(report,null,2));console.log(report);
})();
