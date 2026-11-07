import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {apiNetworkEnvironment} from '../server/network.js';
if(!process.argv.includes('--worker')){const r=spawnSync(process.execPath,[process.argv[1],'--worker'],{env:apiNetworkEnvironment().environment,stdio:'inherit'});process.exit(r.status??1);}
const dir='output/gpt-seam-validation',marker=`${dir}/repair-detail-started.json`;
try{await fs.access(marker);throw new Error('Repair already submitted; no repeated paid request.');}catch(e){if(e.code!=='ENOENT')throw e;}
const {validateMapRequest}=await import('../server/map.js'),{generateWithApiyi}=await import('../server/index.js'),{SEAM_PROMPT}=await import('../src/map/seams.js');
const settings=JSON.parse(await fs.readFile('.local-settings.json','utf8'));
const body=validateMapRequest({provider:'apiyi',operation:'retouch',resolution:'2K',width:706,height:466,outputWidth:706,outputHeight:466,imageBase64:(await fs.readFile(`${dir}/repair-detail-input.png`)).toString('base64'),maskBase64:(await fs.readFile(`${dir}/repair-detail-mask.png`)).toString('base64'),mimeType:'image/png',prompt:SEAM_PROMPT+' Repair the small discontinuity along the thatched roof ridge of the LOWER stone house only. Keep the upper wooden house separate and unchanged.',negativePrompt:'duplicate house, duplicate roof, cut roof, misaligned roof, seam, color band'},settings);
await fs.writeFile(marker,JSON.stringify({model:settings.apiyiImageModel,startedAt:new Date(),size:body.outputSize,prompt:body.prompt},null,2));
try{const r=await generateWithApiyi(settings,body);await fs.writeFile(`${dir}/repair-detail-raw.png`,Buffer.from(r.data,'base64'));console.log('repair saved');}catch(e){await fs.writeFile(`${dir}/repair-detail-error.json`,JSON.stringify({error:e.message}));console.log(e.message);}
