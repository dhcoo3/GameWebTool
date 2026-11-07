import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {apiNetworkEnvironment} from '../server/network.js';
if(!process.argv.includes('--worker')){const r=spawnSync(process.execPath,[process.argv[1],'--worker'],{env:apiNetworkEnvironment().environment,stdio:'inherit'});process.exit(r.status??1);}
const dir='output/gpt-seam-validation',marker=`${dir}/repair-started.json`;
try{await fs.access(marker);throw new Error('Repair already submitted; no repeated paid request.');}catch(e){if(e.code!=='ENOENT')throw e;}
const {validateMapRequest}=await import('../server/map.js'),{generateWithApiyi}=await import('../server/index.js'),{SEAM_PROMPT}=await import('../src/map/seams.js');
const settings=JSON.parse(await fs.readFile('.local-settings.json','utf8'));
const body=validateMapRequest({provider:'apiyi',operation:'retouch',resolution:'2K',width:906,height:756,outputWidth:906,outputHeight:756,imageBase64:(await fs.readFile(`${dir}/repair-input.png`)).toString('base64'),maskBase64:(await fs.readFile(`${dir}/repair-mask.png`)).toString('base64'),mimeType:'image/png',prompt:SEAM_PROMPT+' The thatched stone house has a disconnected roof. Rebuild ONE continuous roof for the same existing house. Preserve its walls, doorway and footprint. Match the roof to both sides; do not add a second house or another roof.',negativePrompt:'duplicate house, duplicate roof, cut roof, misaligned roof, seam, color band'},settings);
await fs.writeFile(marker,JSON.stringify({model:settings.apiyiImageModel,startedAt:new Date(),size:body.outputSize,prompt:body.prompt},null,2));
try{const r=await generateWithApiyi(settings,body);await fs.writeFile(`${dir}/repair-raw.png`,Buffer.from(r.data,'base64'));console.log('repair saved');}catch(e){await fs.writeFile(`${dir}/repair-error.json`,JSON.stringify({error:e.message}));console.log(e.message);}
