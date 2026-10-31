import { execFileSync } from 'node:child_process';

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
export function providerNetworkError(providerName, cause, { elapsedMs = 0, env = process.env, signal } = {}) {
  if (cause?.providerNetworkError || cause?.providerResponse) return cause;
  if (signal?.aborted && signal.reason?.name !== 'TimeoutError') return signal.reason || cause;
  const code = signal?.reason?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : cause?.cause?.code || cause?.code || cause?.name;
  const elapsed = `等待 ${(elapsedMs / 1000).toFixed(1)} 秒`;
  const proxy = env.HTTPS_PROXY || env.https_proxy ? '本机已配置代理，请检查当前代理线路的稳定性。' : '请检查当前网络或代理连接。';
  const timeout = ['REQUEST_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT'].includes(code);
  const interrupted = ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'GEMINI_STREAM_INCOMPLETE'].includes(code);
  const message = timeout ? `${providerName} API 等待超时` : interrupted ? `${providerName} API 传输连接中断` : `${providerName} API 连接失败`;
  return Object.assign(new Error(`${message}（${code || 'NETWORK_ERROR'}，${elapsed}）。${proxy}本次未自动重试；服务可能已接收请求，请先检查服务记录后再决定是否重新生成。`, { cause }), { status: timeout ? 504 : 502, providerNetworkError: true });
}
export function supportsEnvironmentProxy(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 5) || (major === 23 && minor >= 9) || (major === 22 && minor >= 21);
}
export function parseSystemProxy(text) {
  const value = (key) => String(text).match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1];
  const address = (scheme) => {
    if (value(`${scheme}Enable`) !== '1') return '';
    const host = value(`${scheme}Proxy`), port = Number(value(`${scheme}Port`));
    if (!host || !/^[\w.:[\]-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    try { return new URL(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`).origin; } catch { return ''; }
  };
  return { http: address('HTTP'), https: address('HTTPS') };
}
export function apiNetworkEnvironment({ env = process.env, version = process.versions.node, platform = process.platform, readSystemProxy = () => execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }) } = {}) {
  const environment = { ...env }, supported = supportsEnvironmentProxy(version);
  if (supported && !environment.NODE_USE_ENV_PROXY) environment.NODE_USE_ENV_PROXY = '1';
  const explicit = PROXY_VARIABLES.some((name) => Boolean(environment[name]));
  if (platform !== 'darwin' || !supported || explicit || environment.NODE_USE_ENV_PROXY !== '1') return { environment, source: explicit ? 'environment' : 'direct' };
  try {
    const system = parseSystemProxy(readSystemProxy());
    // All provider endpoints use HTTPS. Only enable automatic proxying when the secure web proxy is enabled.
    if (!system.https) return { environment, source: 'direct' };
    environment.HTTPS_PROXY = system.https;
    if (system.http) environment.HTTP_PROXY = system.http;
    if (!environment.NO_PROXY && !environment.no_proxy) environment.NO_PROXY = 'localhost,127.0.0.1,::1';
    return { environment, source: 'system' };
  } catch { return { environment, source: 'direct' }; }
}
