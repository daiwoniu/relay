import assert from 'node:assert/strict';
import test from 'node:test';
import { createServiceRecovery } from '../system/service-recovery.js';
import { createServiceRecoveryRouter } from './service-recovery.js';

const admin = { id: '1', username: 'admin', role: 'admin' as const };
function router() {
  const service = createServiceRecovery({
    isLauncherManaged: () => true, countActiveTasks: () => 0, sendControlMessage: () => true, commitControlMessage: () => true,
    sendSetupMessage: () => true, commitSetupMessage: () => true,
    createOperationId: () => 'op-1', inspectEnvironment: () => ({ required: false, blockedByConflicts: false, server: { needed: false, reason: 'ok' }, client: { needed: false, reason: 'ok' } }),
  });
  return createServiceRecoveryRouter({ service, authenticate: (cookie) => cookie ? admin : null, isOriginAllowed: () => true });
}

test('服务维护路由拒绝旧 Codex 与 setup 动作', async () => {
  for (const action of ['restart_codex', 'upgrade_codex', 'setup_and_restart']) {
    const response = await router().request('/recover', { method: 'POST', headers: { cookie: 'yes', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ action, clientProtocolVersion: 1 }) });
    assert.equal(response.status, 400);
  }
});

test('服务维护路由接受前后端与完整 Relay 动作且确认目标严格', async () => {
  const app = router();
  assert.equal((await app.request('/recover', { method: 'POST', headers: { cookie: 'yes', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restart_frontend', clientProtocolVersion: 10 }) })).status, 202);
  assert.equal((await app.request('/recover/confirm', { method: 'POST', headers: { cookie: 'yes', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'op-1', target: 'frontend' }) })).status, 202);

  const relayApp = router();
  assert.equal((await relayApp.request('/recover', { method: 'POST', headers: { cookie: 'yes', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restart_relay', clientProtocolVersion: 10 }) })).status, 202);
  assert.equal((await relayApp.request('/recover/confirm', { method: 'POST', headers: { cookie: 'yes', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'op-1', target: 'backend' }) })).status, 409);
  assert.equal((await relayApp.request('/recover/confirm', { method: 'POST', headers: { cookie: 'yes', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'op-1', target: 'relay' }) })).status, 202);
});

test('环境异常时路由接受固定 repair_environment 动作与 setup 确认', async () => {
  const service = createServiceRecovery({
    isLauncherManaged: () => true, countActiveTasks: () => 0, sendControlMessage: () => true, commitControlMessage: () => true,
    sendSetupMessage: () => true, commitSetupMessage: () => true, createOperationId: () => 'setup-1',
    inspectEnvironment: () => ({ required: true, blockedByConflicts: false, server: { needed: true, reason: '需要 setup' }, client: { needed: false, reason: 'ok' } }),
  });
  const app = createServiceRecoveryRouter({ service, authenticate: () => admin, isOriginAllowed: () => true });
  assert.equal((await app.request('/recover', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'repair_environment', clientProtocolVersion: 10 }) })).status, 202);
  assert.equal((await app.request('/recover/confirm', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'setup-1', target: 'setup' }) })).status, 202);
});

test('完整重启预构建失败时确认接口返回保留旧服务的明确说明', async () => {
  const service = createServiceRecovery({
    isLauncherManaged: () => true, countActiveTasks: () => 0, sendControlMessage: () => true,
    commitControlMessage: () => ({ status: 'failed', message: '前端构建体积超限。完整重启已取消，现有服务仍在运行。' }),
    createOperationId: () => 'relay-build-failed',
    inspectEnvironment: () => ({ required: false, blockedByConflicts: false, server: { needed: false, reason: 'ok' }, client: { needed: false, reason: 'ok' } }),
  } as any);
  const app = createServiceRecoveryRouter({ service, authenticate: () => admin, isOriginAllowed: () => true });
  assert.equal((await app.request('/recover', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restart_relay', clientProtocolVersion: 10 }) })).status, 202);
  const response = await app.request('/recover/confirm', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'relay-build-failed', target: 'relay' }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /完整重启已取消，现有服务仍在运行/);
});

test('服务维护输出按浏览器持有的 operation ID 查询且严格校验路径参数', async () => {
  const output = { operationId: 'op-1', sequence: 3, lines: ['vite building...', 'dist/index.html 2.90 kB'], status: 'running' as const, updatedAt: 123 };
  const service = createServiceRecovery({
    isLauncherManaged: () => true, countActiveTasks: () => 0, sendControlMessage: () => true, commitControlMessage: () => true,
    getOperationOutput: async (operationId) => operationId === 'op-1' ? output : null,
  });
  const app = createServiceRecoveryRouter({ service, authenticate: (cookie) => cookie ? admin : null, isOriginAllowed: () => true });
  const response = await app.request('/recovery-operations/op-1/output', { headers: { cookie: 'yes' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), output);
  assert.equal((await app.request('/recovery-operations/%2E%2E%2Fescape/output', { headers: { cookie: 'yes' } })).status, 400);
  assert.equal((await app.request('/recovery-operations/op-1/output')).status, 401);
});
