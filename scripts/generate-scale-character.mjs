import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('../public/assets/scale-reference/', import.meta.url);
await mkdir(directory, { recursive: true });
const marker = new URL('request-started.json', directory);
try { await access(marker); throw new Error('已发起过临时角色生成；为避免重复计费，不自动创建第二个任务。'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = await (await fetch('http://127.0.0.1:4179/api/config')).json();
if (!config.configured?.kling) throw new Error('请先配置可灵 API key。');
const request = {
  provider: 'kling', width: 1024, height: 1024, resolution: '1K',
  prompt: 'One single full-body standing adventurer sprite for a dark fantasy 2D isometric pixel-art RPG. Three-quarter front view facing southeast (lower right), consistent orthographic game camera. Dark red hood, brown and gray leather armor, short cloak ending ABOVE the boots, two clearly separated sturdy dark boots. Human proportions, readable silhouette, crisp pixel-art clusters, restrained highlights. Neutral idle pose with both feet at the same ground level. Character fills about 80 percent of image height, entirely inside the frame, generous empty space on all sides. Uniform perfectly flat chroma-key green background RGB(0,255,0), with no gradient, no texture. The character must contain NO green colors. This is a standalone CHARACTER sprite, not a map or landscape. No weapon, no ground, no cast shadow, no text, no border, no extra characters, no sprite sheet, no UI.',
  negativePrompt: 'landscape, map, scenery, terrain, ground plane, pedestal, cast shadow, green clothing, green equipment, multiple characters, cropped head, cropped boots, weapon, text, watermark, sprite sheet, border, background gradient',
};
await writeFile(marker, JSON.stringify({ startedAt: new Date().toISOString(), model: config.models.kling, request }, null, 2));
const response = await fetch('http://127.0.0.1:4179/api/scene/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(250_000) });
const result = await response.json();
if (!response.ok || !result.imageBase64) {
  await writeFile(new URL('generation-error.json', directory), JSON.stringify({ error: result.error || response.status, time: new Date().toISOString() }, null, 2));
  throw new Error(result.error || `生成失败 ${response.status}`);
}
const extension = result.mimeType === 'image/jpeg' ? 'jpg' : result.mimeType === 'image/webp' ? 'webp' : 'png';
const filename = `character-original.${extension}`;
await writeFile(new URL(filename, directory), Buffer.from(result.imageBase64, 'base64'));
await writeFile(new URL('generation.json', directory), JSON.stringify({ provider: 'kling', model: result.model, resolution: '1K', originalFile: filename, generatedAt: new Date().toISOString(), prompt: request.prompt, negativePrompt: request.negativePrompt }, null, 2));
console.log(JSON.stringify({ saved: fileURLToPath(new URL(filename, directory)), model: result.model, resolution: '1K' }));
