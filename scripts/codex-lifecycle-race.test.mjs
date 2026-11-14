import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceSupervisor } from './lib/service-supervisor.mjs';

const message = (type) => ({ channel: 'relay-codex-lifecycle-v1', type });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function harness(overrides = {}) {
  const backend = { pid: 1, exitCode: null, signalCode: null };
  const codex = { pid: 2, exitCode: null, signalCode: null };
  const service = { id: 'codex', name: 'Codex', healthUrl: 'http://test/readyz' };
  const owned = new Map([['backend', { child: backend }], ['codex', { child: codex, service }]]);
  let spawns = 0;
  const supervisor = createServiceSupervisor({
    owned, services: new Map([['codex', service]]), codexIdleTimeoutMs: 5,
    now: Date.now, write() {}, writeError() {},
    spawnChild: () => { spawns++; return { pid: 3, exitCode: null, signalCode: null }; },
    stopChild: async () => {}, waitForReady: async () => {}, ...overrides,
  });
  return { supervisor, backend, codex, owned, spawns: () => spawns };
}

test('回收尚未完成时并发唤醒必须等待退出，只启动一个 Codex', async () => {
  const stopping = deferred();
  const stopEntered = deferred();
  const h = harness({ stopChild: async () => { stopEntered.resolve(); await stopping.promise; } });
  await h.supervisor.handleCodexLifecycleMessage(h.backend, message('idle'));
  // Keep a ref'ed timer only in the test; production idle timers are unref'ed.
  const keepAlive = setTimeout(() => stopEntered.resolve(), 1000);
  await stopEntered.promise;
  clearTimeout(keepAlive);
  assert.equal(h.supervisor.shouldIgnoreExit(h.codex), true);
  const wake1 = h.supervisor.handleCodexLifecycleMessage(h.backend, message('activity_started'));
  const wake2 = h.supervisor.handleCodexLifecycleMessage(h.backend, message('activity_started'));
  assert.equal(h.spawns(), 0);
  stopping.resolve();
  assert.equal((await wake1).ok, true);
  assert.equal((await wake2).ok, true);
  assert.equal(h.spawns(), 1);
  assert.equal(h.owned.get('codex').child.pid, 3);
});

test('启动失败清除本次占位，后续唤醒可以重新启动', async () => {
  let checks = 0;
  const h = harness({ waitForReady: async () => { if (++checks === 1) throw new Error('not ready'); } });
  h.owned.delete('codex');
  await assert.rejects(h.supervisor.handleCodexLifecycleMessage(h.backend, message('activity_started')), /not ready/);
  assert.equal(h.owned.has('codex'), false);
  assert.equal((await h.supervisor.handleCodexLifecycleMessage(h.backend, message('activity_started'))).ok, true);
  assert.equal(h.spawns(), 2);
});

test('旧后端的空闲或唤醒消息不能影响现有 Codex', async () => {
  const h = harness();
  assert.equal((await h.supervisor.handleCodexLifecycleMessage({ pid: 99 }, message('idle'))).reason, 'untrusted_source');
  assert.equal((await h.supervisor.handleCodexLifecycleMessage({ pid: 99 }, message('activity_started'))).reason, 'untrusted_source');
  assert.equal(h.owned.get('codex').child, h.codex);
  assert.equal(h.spawns(), 0);
});
