import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = path.join(root, '.local/ui-segmentation');
const python = path.join(runtime, '.venv/bin/python');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
if (!fs.existsSync(python)) run('python3', ['-m', 'venv', path.join(runtime, '.venv')]);
run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '-r', 'scripts/ui-segmentation/requirements.lock.txt']);
run(python, ['scripts/ui-segmentation/download_model.py']);
console.log('Local image-segmentation runtime ready. Production UI is unchanged until the pilot passes.');
