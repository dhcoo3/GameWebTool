import test from 'node:test';
import assert from 'node:assert/strict';
import { apiNetworkEnvironment, parseSystemProxy, supportsEnvironmentProxy } from '../server/network.js';

const system = '<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 7897\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7897\n}';
test('macOS 已有系统代理供 API 子进程使用，本地地址直连且不修改输入环境', () => {
  const env = { PATH: '/mock' }, result = apiNetworkEnvironment({ env, platform: 'darwin', version: '26.12.0', readSystemProxy: () => system });
  assert.equal(result.source, 'system'); assert.equal(result.environment.HTTPS_PROXY, 'http://127.0.0.1:7897'); assert.equal(result.environment.HTTP_PROXY, result.environment.HTTPS_PROXY); assert.equal(result.environment.NODE_USE_ENV_PROXY, '1'); assert.match(result.environment.NO_PROXY, /127\.0\.0\.1/); assert.deepEqual(env, { PATH: '/mock' });
});
test('显式代理、禁用选项、非 macOS 和旧 Node 均不被系统自动检测覆盖', () => {
  const unexpected = () => { throw new Error('不应读取系统代理'); };
  for (const env of [{ HTTPS_PROXY: 'http://custom.test:8080', NO_PROXY: 'company.test' }, { https_proxy: 'http://custom.test:8080' }, { ALL_PROXY: 'socks5://localhost:1080' }, { NODE_USE_ENV_PROXY: '0' }]) {
    const result = apiNetworkEnvironment({ env, platform: 'darwin', version: '26.12.0', readSystemProxy: unexpected });
    for (const [name, value] of Object.entries(env)) assert.equal(result.environment[name], value);
    assert.notEqual(result.source, 'system');
  }
  for (const [platform, version] of [['linux', '26.12.0'], ['darwin', '20.0.0']]) assert.equal(apiNetworkEnvironment({ env: {}, platform, version, readSystemProxy: unexpected }).source, 'direct');
});
test('无系统代理、仅 SOCKS/PAC 或无效地址端口不被当作 HTTPS 代理', () => {
  for (const text of ['', 'SOCKSEnable : 1\nSOCKSProxy : localhost\nSOCKSPort : 7897', 'ProxyAutoConfigEnable : 1', system.replace('HTTPSPort : 7897', 'HTTPSPort : 99999'), system.replace('HTTPSProxy : 127.0.0.1', 'HTTPSProxy : invalid@host')]) {
    const result = apiNetworkEnvironment({ env: {}, platform: 'darwin', version: '26.12.0', readSystemProxy: () => text }); assert.equal(result.source, 'direct'); assert.equal(result.environment.HTTPS_PROXY, undefined);
  }
  assert.deepEqual(parseSystemProxy('HTTPSEnable : 1\nHTTPSProxy : ::1\nHTTPSPort : 7897'), { http: '', https: 'http://[::1]:7897' });
});
test('仅在 Node 支持环境代理的版本启用，系统读取失败不会阻止服务启动', () => {
  for (const version of ['22.21.0', '23.9.0', '24.5.0', '25.0.0', '26.12.0']) assert.ok(supportsEnvironmentProxy(version));
  for (const version of ['20.0.0', '22.20.0', '23.8.0', '24.4.0']) assert.ok(!supportsEnvironmentProxy(version));
  assert.equal(apiNetworkEnvironment({ env: {}, platform: 'darwin', version: '26.12.0', readSystemProxy: () => { throw new Error('unavailable'); } }).source, 'direct');
});
