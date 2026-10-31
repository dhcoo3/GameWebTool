import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiNetworkEnvironment } from './network.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const { environment: apiEnvironment, source: proxySource } = apiNetworkEnvironment();
if (proxySource === 'system') console.log('本机 API 将使用 macOS 已启用的系统代理，本地网页连接保持直连。');
const children = [
  spawn(process.execPath, [path.join(appRoot, 'server', 'index.js')], { cwd: appRoot, stdio: 'inherit', env: apiEnvironment }),
  spawn(process.execPath, [viteBin, '--host', '127.0.0.1'], { cwd: appRoot, stdio: 'inherit', env: process.env }),
];
let closing = false;
function stop(signal = 'SIGTERM') {
  if (closing) return;
  closing = true;
  for (const child of children) if (!child.killed) child.kill(signal);
  setTimeout(() => process.exit(0), 300).unref();
}
for (const child of children) child.on('exit', (code) => {
  if (!closing && code !== 0) {
    console.error('本机服务或网页开发服务器已退出。');
    stop();
    process.exitCode = code || 1;
  }
});
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
