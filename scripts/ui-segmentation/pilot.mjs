import fs from 'node:fs/promises';
import path from 'node:path';
import { UiSegmentationWorker } from '../../server/uiSegmentationWorker.js';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/ui-segmentation/pilot.mjs SOURCE.png [OUTPUT_DIRECTORY]');
const output = path.resolve(process.argv[3] || 'output/ui-segmentation-pilot');
const imageBase64 = (await fs.readFile(source)).toString('base64');
// Visually calibrated SOURCE-pixel bounds. These test mask quality with good
// prompts; they are explicitly NOT claimed to be automatic VLM detections.
const assets = [
  { id: 'login-button', bounds: { x: 1146, y: 631, width: 584, height: 132 } },
  { id: 'title-ornament', bounds: { x: 1160, y: 246, width: 555, height: 310 } },
  { id: 'outer-panel', bounds: { x: 1080, y: 142, width: 715, height: 806 } },
];
await fs.mkdir(output, { recursive: true });
const worker = new UiSegmentationWorker({ timeoutMs: 240_000 });
try {
  const status = await worker.request('status');
  console.log(JSON.stringify(status));
  const report = { source: path.resolve(source), promptOrigin: 'visually-calibrated-boxes-not-automatic-detection', assets, runs: [] };
  for (const regionMode of ['local', 'full']) {
    const result = await worker.request('segment', { imageBase64, assets, regionMode });
    for (const item of result.assets) {
      for (const mask of item.candidates) {
        const file = `${regionMode}-${item.id}-${mask.candidate}.mask.png`;
        await fs.writeFile(path.join(output, file), Buffer.from(mask.maskBase64, 'base64'));
        delete mask.maskBase64;
        mask.file = file;
      }
      console.log(JSON.stringify({ regionMode, id: item.id, elapsedMs: item.elapsedMs, scores: item.candidates.map((m) => m.modelScore), device: item.device }));
    }
    report.runs.push({ regionMode, ...result });
    await fs.writeFile(path.join(output, 'pilot-results.json'), JSON.stringify(report, null, 2));
  }
  // Recorded second-pass part-box experiment for this exact 1920x1080 fixture.
  for (const regionMode of ['full', 'local']) {
    const result = await worker.request('segment', { imageBase64, regionMode, assets: [
      { id: 'compass', bounds: { x: 1360, y: 244, width: 157, height: 158 } },
      { id: 'title-body', bounds: { x: 1158, y: 300, width: 558, height: 258 } },
    ] });
    await fs.writeFile(path.join(output, `refinement-${regionMode}.json`), JSON.stringify(result));
  }
} finally {
  worker.close();
}
