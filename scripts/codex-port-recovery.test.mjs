import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { canBindEndpoint, readCodexRuntimeConfig, recoverCodexRuntimeConfig, relayTargetReleased } from './lib/codex-port-recovery.mjs';

const config = { codex: { host: '127.0.0.1', port: 9281, wsUrl: 'ws://127.0.0.1:9281', readyUrl: 'http://127.0.0.1:9281/readyz' }, backend: { port: 9181 }, frontend: { port: 9081 } };
function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { platform: 'win32', pidExistsFn: () => false, delay: async () => {}, canBindFn: async () => true,
    findListeningPidsFn: ports => new Map(ports.map(port => [port, port === 9281 ? [42] : []])) };
  return { root, options };
}
test('未启用 Codex 时不读取运行记录、不扫描或切换其端口', async t => {
  const { root, options } = harness(t);
  fs.mkdirSync(path.join(root, '.relay-dev'));
  fs.writeFileSync(path.join(root, '.relay-dev', 'codex-runtime-endpoint.json'), 'invalid json');
  assert.equal(await recoverCodexRuntimeConfig(root, config, { ...options, enabled: false,
    findListeningPidsFn: () => assert.fail('不应检查未启用的 Codex') }), config);
});
test('已消失PID的残留监听切换端口并由所有命令复用，用户配置不变', async t => {
  const { root, options } = harness(t);
  const output = [];
  const recovered = await recoverCodexRuntimeConfig(root, config, { ...options, write: line => output.push(line) });
  assert.equal(recovered.codex.port, 9282);
  assert.equal(recovered.codex.wsUrl, 'ws://127.0.0.1:9282');
  assert.equal(recovered.codex.readyUrl, 'http://127.0.0.1:9282/readyz');
  assert.equal(readCodexRuntimeConfig(root, config).codex.port, 9282);
  assert.equal(config.codex.port, 9281);
  assert.match(output[0], /无需重启 Windows/);
  assert.equal(readCodexRuntimeConfig(root, { ...config, codex: { ...config.codex, port: 9381 } }).codex.port, 9381);
});
test('存活或权限不可确认的进程不会被当作幽灵监听绕过', async t => {
  const { root, options } = harness(t);
  const current = await recoverCodexRuntimeConfig(root, config, { ...options, pidExistsFn: () => true });
  assert.equal(current.codex.port, 9281);
  assert.equal(fs.existsSync(path.join(root, '.relay-dev')), false);
});
test('重复采样排除瞬时残留，不擅自修改运行端口', async t => {
  const { root, options } = harness(t);
  let samples = 0;
  const current = await recoverCodexRuntimeConfig(root, config, { ...options,
    findListeningPidsFn: ports => new Map(ports.map(port => [port, ++samples === 1 ? [42] : []])) });
  assert.equal(current.codex.port, 9281);
});
test('候选端口必须同时无监听且可绑定，跳过真实占用及残留', async t => {
  const { root, options } = harness(t);
  const recovered = await recoverCodexRuntimeConfig(root, config, { ...options,
    findListeningPidsFn: ports => new Map(ports.map(port => [port, [9281, 9282].includes(port) ? [42] : []])),
    canBindFn: async target => target.port !== 9283 });
  assert.equal(recovered.codex.port, 9284);
});
test('候选全部不可绑定时失败且不留下错误运行记录', async t => {
  const { root, options } = harness(t);
  await assert.rejects(recoverCodexRuntimeConfig(root, config, { ...options, canBindFn: async () => false }), /32.*无需重启 Windows/);
  assert.equal(readCodexRuntimeConfig(root, config).codex.port, 9281);
});
test('真实端口验证不把连接失败当作可绑定，释放后可以再次绑定', async t => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { if (server.listening) server.close(); });
  const target = { host: '127.0.0.1', port: server.address().port };
  assert.equal(await canBindEndpoint(target), false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await canBindEndpoint(target), true);
});
test('Windows禁止绑定的候选端口视为不可用，其他绑定错误保留原因', async () => {
  const options = code => ({ createServer: () => {
    const server = new EventEmitter();
    server.listen = () => queueMicrotask(() => server.emit('error', Object.assign(new Error(code), { code })));
    return server;
  } });
  assert.equal(await canBindEndpoint({ host: '127.0.0.1', port: 9282 }, options('EACCES')), false);
  await assert.rejects(canBindEndpoint({ host: 'invalid', port: 9282 }, options('EADDRNOTAVAIL')), { code: 'EADDRNOTAVAIL' });
});
test('重启门禁只允许Codex幽灵残留，其他端口和活PID继续阻止换代', async () => {
  const options = { platform: 'win32', pidExistsFn: () => false, findListeningPidsFn: ports => new Map(ports.map(port => [port, [42]])) };
  assert.equal(await relayTargetReleased({ host: '127.0.0.1', port: 9281 }, 9281, options), true);
  assert.equal(await relayTargetReleased({ host: '127.0.0.1', port: 9181 }, 9281, options), false);
  assert.equal(await relayTargetReleased({ host: '127.0.0.1', port: 9281 }, 9281, { ...options, pidExistsFn: () => true }), false);
});
