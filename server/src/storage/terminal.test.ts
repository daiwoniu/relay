import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs, CoreCommandName, StorageCommandEnvelope } from './contracts.js';

const runtime = { kind: 'runtime' as const, sessionId: 'session', attemptId: 'attempt', connectionId: 'connection', runtimeVersion: 1 };
function command<K extends CoreCommandName>(operationId: string, name: K, input: CoreCommandInputs[K]) {
  return { ...markRead(), operationId, principal: runtime, command: { name, input } } as StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } };
}
const content = 'result '.repeat(20_000).trim();
const fact = { id: 'fact', sessionId: 'session', attemptId: 'attempt', engineId: 'codex' as const,
  connectionId: 'connection', externalTurnId: 'new-turn', factType: 'final_answer_completed' as const,
  source: 'realtime' as const, sequence: 1, idempotencyKey: 'fact-key', observedAt: 100,
  payload: { hasContent: true, contentLength: content.length, contentDigest: createHash('sha256').update(content).digest('hex') } };
function terminal() { return command('terminal', 'turn.projectTerminal', {
  decision: { id: 'decision', sessionId: 'session', attemptId: 'attempt', engineId: 'codex', externalTurnId: 'new-turn',
    outcome: 'completed', reasonCode: 'FINAL_ANSWER_COMPLETED', factId: 'fact', decidedAt: 100, projectedAt: null },
  message: { id: 'terminal-message', turnId: 'new-turn', content, items: null, metadata: null, durationMs: 10 },
}); }

test('fact and terminal commit once, release capacity, and keep large message bodies out of receipts', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    await client.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime });
    assert.equal((await client.execute(command('fact', 'turn.appendFact', { fact }))).state, 'committed');
    const result = await client.execute(terminal());
    assert.equal(result.state, 'committed');
    if (result.state === 'committed') assert.equal(result.value.savedMessage.content, content);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 0);
    assert.equal(f.scalar('SELECT active_attempt_id FROM sessions'), null);
    assert.ok(Number(f.scalar("SELECT length(result_json) FROM _relay_storage_operations WHERE operation_id='terminal'")) < 4096);
    const replay = await client.execute(terminal());
    assert.equal(replay.state, 'committed');
    if (replay.state === 'committed') { assert.equal(replay.replayed, true); assert.equal(replay.value.savedMessage.content, content); }
    assert.equal(f.scalar('SELECT count(*) FROM engine_terminal_decisions'), 1);
    assert.equal(f.scalar("SELECT count(*) FROM messages WHERE id='terminal-message'"), 1);
    assert.equal((await client.execute(command('late-fact', 'turn.appendFact', { fact: { ...fact, id: 'late', idempotencyKey: 'late' } }))).state, 'rejected');
    f.mutate("UPDATE messages SET content='repaired' WHERE id='terminal-message'");
    assert.equal((await client.lookup({ storeId: 'store', operationId: 'terminal', principal: runtime })).state, 'expired');
    assert.deepEqual(await client.execute(terminal()), { state: 'rejected', operationId: 'terminal', code: 'OPERATION_EXPIRED' });
    assert.equal(f.scalar("SELECT content FROM messages WHERE id='terminal-message'"), 'repaired');
  } finally { await client.close(); f.cleanup(); }
});

test('terminal receipt failure preserves active attempt, message revision, decision and lease atomically', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    f.mutate("INSERT INTO engine_provider_cooldowns VALUES('codex:default',1,1,'attempt',1,NULL,1)");
    await client.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime });
    await client.execute(command('fact', 'turn.appendFact', { fact }));
    f.mutate("CREATE TRIGGER fail_terminal BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='turn.projectTerminal' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await client.execute(terminal())).state, 'unknown');
    assert.equal(f.scalar('SELECT active_attempt_id FROM sessions'), 'attempt');
    assert.equal(f.scalar('SELECT message_revision FROM sessions'), 2);
    assert.equal(f.scalar('SELECT count(*) FROM engine_terminal_decisions'), 0);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 1);
    assert.equal(f.scalar('SELECT probe_attempt_id FROM engine_provider_cooldowns'), 'attempt');
    assert.equal(f.scalar("SELECT count(*) FROM messages WHERE id='terminal-message'"), 0);
    f.mutate('DROP TRIGGER fail_terminal');
    assert.equal((await client.execute(terminal())).state, 'committed');
    assert.equal(f.scalar('SELECT probe_attempt_id FROM engine_provider_cooldowns'), null);
  } finally { await client.close(); f.cleanup(); }
});

test('disabled accounts cannot start new claims but an already running lease can finish safely', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    await client.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime });
    f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");
    assert.equal((await client.execute(command('fact', 'turn.appendFact', { fact }))).state, 'committed');
    assert.equal((await client.execute(terminal())).state, 'committed');
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 0);
    await assert.rejects(client.readMessages({ principal: markRead().principal, sessionId: 'session', limit: 1, before: null }), /FORBIDDEN/);
  } finally { await client.close(); f.cleanup(); }
});
