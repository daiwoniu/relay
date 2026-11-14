import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NativeStore } from './native-store.js';
import { fixture, markRead } from './storage-fixture.test-support.js';
import type { StorageCommandEnvelope } from './contracts.js';
import { operationIdentity } from './command-boundary.js';

test('opening requires an existing application database and explicit support-schema initialization', () => {
  const f = fixture();
  try {
    const absent = path.join(f.directory, 'absent.db');
    assert.throws(() => new NativeStore(absent, 'store', 1)); assert.equal(fs.existsSync(absent), false);
    assert.throws(() => new NativeStore(f.filename, 'store', 1));
    const store = new NativeStore(f.filename, 'store', 1, true); store.close();
    assert.throws(() => new NativeStore(f.filename, 'wrong', 1), /CONFLICT/);
    const reopened = new NativeStore(f.filename, 'store', 2); reopened.close();
    f.mutate('DROP INDEX _relay_fact_turn_owner');
    assert.throws(()=>new NativeStore(f.filename,'store',3),/STORAGE_UNAVAILABLE/);
    assert.throws(()=>new NativeStore(f.filename,'store',3,true),/STORAGE_UNAVAILABLE/);
    assert.equal(f.scalar("SELECT count(*) FROM sqlite_master WHERE name='_relay_fact_turn_owner'"),0,'existing unsupported candidate must not be silently migrated');
  } finally { f.cleanup(); }
});

test('business update and receipt commit atomically; replays, changed intent and revoked auth are distinct', () => {
  const f = fixture(); const store = new NativeStore(f.filename, 'store', 1, true);
  try {
    const request = markRead();
    const first = store.execute(request); assert.equal(first.state, 'committed');
    const replay = store.execute(request); assert.equal(replay.state, 'committed');
    if (replay.state === 'committed') assert.equal(replay.replayed, true);
    assert.equal(f.scalar('SELECT count(*) FROM session_read_receipts'), 1);
    assert.equal(store.lookup({ storeId: 'store', operationId: 'read', principal: request.principal }).state, 'committed');
    const changed = markRead(); changed.command.input.messageId = 'm1';
    assert.equal(store.lookup({ storeId: 'store', operationId: 'read', principal: request.principal,
      expected: { commandName: request.command.name, inputDigest: operationIdentity(request).inputDigest } }).state, 'committed');
    assert.throws(() => store.lookup({ storeId: 'store', operationId: 'read', principal: request.principal,
      expected: { commandName: changed.command.name, inputDigest: operationIdentity(changed).inputDigest } }), /CONFLICT/);
    assert.throws(() => store.lookup({ storeId: 'store', operationId: 'read', principal: request.principal, expected: null } as any), /INVALID_ARGUMENT/);
    assert.deepEqual(store.execute(changed), { state: 'rejected', operationId: 'read', code: 'CONFLICT' });
    assert.deepEqual(store.execute(markRead('other-read', 'other')), { state: 'rejected', operationId: 'other-read', code: 'FORBIDDEN' });
    const encoded = String(f.scalar('SELECT principal_json FROM _relay_storage_operations'));
    assert.ok(!encoded.includes('auth-owner'));
    f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");
    assert.deepEqual(store.execute(request), { state: 'rejected', operationId: 'read', code: 'FORBIDDEN' });
    assert.throws(() => store.lookup({ storeId: 'store', operationId: 'read', principal: request.principal }), /FORBIDDEN/);
  } finally { store.close(); f.cleanup(); }
});

test('receipt failure rolls back the business update; tombstone rejects old operation reuse', () => {
  const f = fixture(); const store = new NativeStore(f.filename, 'store', 1, true);
  try {
    f.mutate("CREATE TRIGGER stop_receipt BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.equal(store.execute(markRead()).state, 'unknown');
    assert.equal(f.scalar('SELECT count(*) FROM session_read_receipts'), 0);
    assert.equal(f.scalar('SELECT count(*) FROM _relay_storage_operations'), 0);
    f.mutate('DROP TRIGGER stop_receipt');
    assert.equal(store.execute(markRead()).state, 'committed');
    f.mutate('UPDATE _relay_storage_operations SET expired=1,result_json=NULL');
    assert.deepEqual(store.execute(markRead()), { state: 'rejected', operationId: 'read', code: 'OPERATION_EXPIRED' });
  } finally { store.close(); f.cleanup(); }
});

test('runtime generation, lease and active attempt fence usage updates and host metadata', () => {
  const f = fixture(); const store = new NativeStore(f.filename, 'store', 1, true);
  const runtime = { kind: 'runtime' as const, sessionId: 'session', attemptId: 'attempt', connectionId: 'connection', runtimeVersion: 1 };
  const command: StorageCommandEnvelope = { ...markRead(), operationId: 'usage', principal: runtime,
    command: { name: 'turn.updateUsage', input: { sessionId: 'session', attemptId: 'attempt', usage: { tokens: 12 } } } };
  try {
    assert.equal(store.execute(command).state, 'rejected');
    assert.throws(() => store.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'wrong', runtime }), /FORBIDDEN/);
    store.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime });
    assert.equal(store.execute(command).state, 'committed');
    assert.equal(JSON.parse(String(f.scalar('SELECT active_turn_usage FROM sessions'))).tokens, 12);
    store.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime: { ...runtime, connectionId: 'new', runtimeVersion: 2 } });
    assert.deepEqual(store.execute({ ...command, operationId: 'late' }), { state: 'rejected', operationId: 'late', code: 'FORBIDDEN' });
    assert.throws(() => store.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime }), /CONFLICT/);
    assert.throws(() => store.execute({ ...command, workerGeneration: 0 }), /CONFLICT/);
    const current = { ...runtime, connectionId: 'new', runtimeVersion: 2 };
    f.mutate("UPDATE engine_resource_leases SET lease_token='rotated'");
    assert.deepEqual(store.execute({ ...command, operationId: 'rotated', principal: current }),
      { state: 'rejected', operationId: 'rotated', code: 'FORBIDDEN' });
    f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");
    assert.equal(store.lookup({ storeId: 'store', operationId: 'usage', principal: current }).state, 'committed');
    assert.throws(() => store.readMessages({ principal: current, sessionId: 'session', limit: 1, before: null }), /FORBIDDEN/);
  } finally { store.close(); f.cleanup(); }
});

test('host-context marker preserves metadata, reports corrupt no-op and rejects stale compaction', () => {
  const f = fixture(); const store = new NativeStore(f.filename, 'store', 1, true);
  const runtime = { kind: 'runtime' as const, sessionId: 'session', attemptId: 'attempt', connectionId: 'connection', runtimeVersion: 1 };
  try {
    store.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime });
    f.mutate(`UPDATE sessions SET engine_metadata='{"kept":7}'`);
    const request: StorageCommandEnvelope = { ...markRead(), operationId: 'host', principal: runtime, command: {
      name: 'turn.setHostContext', input: { sessionId: 'session', engineId: 'codex', externalSessionId: 'thread', compactionCount: 0, delivered: true } } };
    assert.equal(store.execute(request).state, 'committed');
    assert.equal(JSON.parse(String(f.scalar('SELECT engine_metadata FROM sessions'))).kept, 7);
    f.mutate("UPDATE sessions SET context_compaction_count=1");
    assert.deepEqual(store.execute({ ...request, operationId: 'late-host' }), { state: 'rejected', operationId: 'late-host', code: 'CONFLICT' });
    f.mutate("UPDATE sessions SET context_compaction_count=0,engine_metadata='broken'");
    const result = store.execute({ ...request, operationId: 'corrupt-host' });
    assert.equal(result.state, 'committed'); if (result.state === 'committed') assert.deepEqual(result.value, { updated: false });
    assert.equal(f.scalar('SELECT engine_metadata FROM sessions'), 'broken');
  } finally { store.close(); f.cleanup(); }
});

test('paged reads preserve chronological order, authorization and a stable backward cursor', () => {
  const f = fixture(); const store = new NativeStore(f.filename, 'store', 1, true);
  try {
    const request = { principal: markRead().principal, sessionId: 'session', limit: 1, before: null };
    const page = store.readMessages(request); assert.equal(page.messages[0].id, 'm2');
    assert.equal(store.readMessages({ ...request, before: page.nextCursor }).messages[0].id, 'm1');
    assert.deepEqual(store.readMessages({ ...request, limit: 100 }).messages.map((m) => m.id), ['m1', 'm2']);
    assert.throws(() => store.readMessages({ ...request, principal: markRead('x', 'other').principal }), /FORBIDDEN/);
    assert.equal(store.readMessages({ ...request, principal: markRead('x', 'admin').principal }).messages.length, 1);
    assert.throws(() => store.readMessages({ ...request, limit: 101 }), /INVALID_ARGUMENT/);
    assert.throws(() => store.readMessages({ ...request, principal: { kind: 'system', purpose: 'forged' } as never }), /INVALID_ARGUMENT/);
  } finally { store.close(); f.cleanup(); }
});
