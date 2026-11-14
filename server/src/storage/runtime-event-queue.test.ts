import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEventQueue, type RuntimeFence } from './runtime-event-queue.js';

const fence = (): RuntimeFence => ({ runtime: {}, sessionId: 'session', attemptId: 'attempt', connectionId: 'connection', version: 1 });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test('terminal waits for earlier persistence while other event-loop work remains possible', async () => {
  const token = fence(); const queue = new RuntimeEventQueue((input) => input.runtime === token.runtime);
  const gate = deferred(); const order: string[] = [];
  const fact = queue.enqueue(token, 10, async (guard) => { order.push('fact'); await gate.promise; guard.assertCurrent(); order.push('committed'); });
  const terminal = queue.enqueue(token, 20, () => { order.push('terminal'); });
  await Promise.resolve();
  assert.deepEqual(order, ['fact']); assert.equal(queue.health().pending, 2);
  gate.resolve(); assert.equal((await fact).state, 'handled'); assert.equal((await terminal).state, 'handled');
  assert.deepEqual(order, ['fact', 'committed', 'terminal']); await queue.close();
});

test('retired runtime after await suppresses late publication; queued token is immutable', async () => {
  const token = fence(); let current = { ...token }; const gate = deferred(); let published = false;
  const queue = new RuntimeEventQueue((input) => input.runtime === current.runtime && input.version === current.version && input.connectionId === current.connectionId);
  const old = queue.enqueue(token, 1, async (guard) => { await gate.promise; guard.assertCurrent(); published = true; });
  await Promise.resolve();
  token.version = 9; // Mutating the caller's token cannot change an already captured fence.
  current = { ...current, runtime: {}, connectionId: 'new', version: 2 };
  gate.resolve(); assert.deepEqual(await old, { state: 'stale' }); assert.equal(published, false);
  assert.deepEqual(await queue.enqueue(token, 1, () => { published = true; }), { state: 'stale' });
  assert.equal(queue.health().failed, false); await queue.close();
});

test('persistence failure blocks later terminal work and close cannot claim success', async () => {
  const token = fence(); let failures = 0; let terminal = false;
  const queue = new RuntimeEventQueue(() => true, { onFailure: () => { failures++; } });
  const error = new Error('synthetic');
  const first = queue.enqueue(token, 1, () => { throw error; });
  const second = queue.enqueue(token, 1, () => { terminal = true; });
  await assert.rejects(first, (actual) => actual === error);
  await assert.rejects(second, /FAILED/);
  assert.equal(terminal, false); assert.equal(failures, 1); assert.equal(queue.health().pending, 0);
  await assert.rejects(queue.close(), /FAILED/);
});

test('count/byte limits and closing reject new work but drain accepted events', async () => {
  const token = fence(); const gate = deferred();
  const queue = new RuntimeEventQueue(() => true, { maxPending: 1, maxBytes: 4 });
  const first = queue.enqueue(token, 4, () => gate.promise);
  await assert.rejects(queue.enqueue(token, 1, () => undefined), /OVERLOADED/);
  const closing = queue.close();
  await assert.rejects(queue.enqueue(token, 0, () => undefined), /CLOSED/);
  gate.resolve(); await first; await closing;
  assert.deepEqual(queue.health(), { pending: 0, bytes: 0, closed: true, failed: false });
});
