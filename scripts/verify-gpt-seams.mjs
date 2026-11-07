import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { apiNetworkEnvironment } from '../server/network.js';
if(!process.argv.includes('--worker')) {
  const r=spawnSync(process.execPath,[process.argv[1],'--worker'],{env:apiNetworkEnvironment().environment,stdio:'inherit'});process.exit(r.status??1);
}
const { validateMapRequest }=await import('../server/map.js');
const { generateWithApiyi }=await import('../server/index.js');
const settings=JSON.parse(await fs.readFile('.local-settings.json','utf8'));
const dir='output/gpt-seam-validation';
for(const [name,height] of [['strip',1024],['anchor',1536]]) {
  const marker=`${dir}/${name}-started.json`;
  try { await fs.access(marker); console.log(`${name}: already submitted, skipped`);continue; }catch{}
  const body=validateMapRequest({provider:'apiyi',operation:'expand',resolution:'2K',width:1920,height,outputWidth:1920,outputHeight:height,
    imageBase64:(await fs.readFile(`${dir}/${name}-input.png`)).toString('base64'),maskBase64:(await fs.readFile(`${dir}/${name}-mask.png`)).toString('base64'),mimeType:'image/png',
    prompt:'Extend this exact dark medieval pixel-art village northwards into the transparent masked area. Continue the existing buildings, roofs, tree trunks and paths where they cross the boundary. Keep the same camera zoom, object sizes, muted palette and pixel texture. Include a church courtyard toward the north. Preserve all protected pixels and their exact coordinates. Return the full input frame, no cropping, zooming, borders or padding.',negativePrompt:'text, grid, border, floating slab, black void, duplicated buildings'},settings);
  await fs.writeFile(marker,JSON.stringify({model:settings.apiyiImageModel,startedAt:new Date(),width:body.width,height:body.height,outputSize:body.outputSize,prompt:body.prompt},null,2));
  try { const result=await generateWithApiyi(settings,body);await fs.writeFile(`${dir}/${name}-raw.png`,Buffer.from(result.data,'base64'));console.log(`${name}: saved`); }
  catch(e){await fs.writeFile(`${dir}/${name}-error.json`,JSON.stringify({error:e.message}));console.log(`${name}: ${e.message}`);break;}
}
