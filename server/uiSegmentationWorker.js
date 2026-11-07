import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = fileURLToPath(new URL('../', import.meta.url));

// Kept separate from the production API until the image-quality pilot passes.
export class UiSegmentationWorker {
  constructor({ idleMs = 120_000, timeoutMs = 180_000 } = {}) {
    this.idleMs = idleMs;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.process = null;
    this.pending = null;
    this.idle = null;
    this.closed = false;
  }

  start() {
    if (this.process) return;
    const child = spawn(path.join(appRoot, '.local/ui-segmentation/.venv/bin/python'),
      ['-u', path.join(appRoot, 'scripts/ui-segmentation/worker.py')], {
        cwd: appRoot, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
      });
    this.process = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending;
      if (!pending || message.id !== pending.id) return;
      this.pending = null;
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.type}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    const fail = (error) => {
      if (this.process === child) this.process = null;
      const pending = this.pending;
      if (pending?.child === child) { this.pending = null; clearTimeout(pending.timer); pending.reject(error); }
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', (code, signal) => {
      lines.close();
      fail(new Error(`Local segmentation worker exited (${code ?? signal}). ${stderr}`.trim()));
    });
  }

  request(op, input = {}) {
    const run = this.queue.then(() => {
      if (this.closed) throw new Error('Segmentation worker is closed');
      clearTimeout(this.idle);
      this.start();
      const child = this.process, id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending?.id === id) this.pending = null;
          if (this.process === child) this.process = null;
          child.kill();
          reject(new Error(`Local segmentation timed out after ${this.timeoutMs} ms`));
        }, this.timeoutMs);
        this.pending = { id, resolve, reject, timer, child };
        child.stdin.write(`${JSON.stringify({ ...input, id, op })}\n`);
      }).finally(() => {
        this.idle = setTimeout(() => this.stop(), this.idleMs);
        this.idle.unref();
      });
    });
    this.queue = run.catch(() => {});
    return run;
  }

  stop() {
    clearTimeout(this.idle);
    const child = this.process;
    this.process = null;
    if (child) child.kill();
  }

  close() { this.closed = true; this.stop(); }
}
