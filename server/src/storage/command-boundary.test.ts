import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, lostReply, operationIdentity, parseCommandEnvelope, StorageContractError } from './command-boundary.js';
import type { StorageCommandEnvelope } from './contracts.js';

function enqueue(): StorageCommandEnvelope {
  return { protocolVersion: 1, storeId: 'store', requestId: 'rpc-1', workerGeneration: 1, operationId: 'message-1',
    principal: { kind: 'user', userId: 'owner', authSessionHash: 'PRIVATE_AUTH' },
    command: { name: 'turn.enqueue', input: { sessionId: 'session', attemptId: 'attempt', messageId: 'message-1',
      engineId: 'codex', resourceKey: 'codex:default', content: 'PRIVATE_BODY', metadata: null,
      origin: { kind: 'direct' }, expectedPreferencesRevision: 0 } } };
}

const rejects = (action: () => unknown, code: string) => assert.throws(action,
  (error) => error instanceof StorageContractError && error.code === code && error.message === code);

test('canonical JSON is stable but refuses lossy values, getters, cycles and pathological payloads', () => {
  assert.equal(canonicalJson({ b: [true, null], a: 'x' }), canonicalJson({ a: 'x', b: [true, null] }));
  for (const value of [undefined, 1n, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, new Date(), new Uint8Array([1]),
    { a: undefined }, Array(2), Object.assign([1], { extra: 2 }), JSON.parse('{"__proto__":{}}')]) {
    rejects(() => canonicalJson(value), 'INVALID_ARGUMENT');
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  rejects(() => canonicalJson(cycle), 'INVALID_ARGUMENT');
  let called = false;
  const getter = { get value() { called = true; return 'secret'; } };
  rejects(() => canonicalJson(getter), 'INVALID_ARGUMENT'); assert.equal(called, false);
  rejects(() => canonicalJson({ x: 'large' }, 5), 'PAYLOAD_TOO_LARGE');
  let nested: unknown = 1;
  for (let i = 0; i < 40; i++) nested = { child: nested };
  rejects(() => canonicalJson(nested), 'PAYLOAD_TOO_LARGE');
});

test('identity follows stable business actor while RPC, auth refresh and worker generation change', () => {
  const original = enqueue();
  const identity = operationIdentity(original);
  const reconnect = structuredClone(original);
  reconnect.requestId = 'rpc-2'; reconnect.workerGeneration = 9;
  reconnect.principal = { kind: 'user', userId: 'owner', authSessionHash: 'NEW_AUTH' };
  assert.deepEqual(operationIdentity(reconnect), identity);
  assert.ok(!JSON.stringify(identity).includes('PRIVATE_AUTH'));
  assert.ok(!JSON.stringify(identity).includes('PRIVATE_BODY'));
  const changed = enqueue();
  if (changed.command.name !== 'turn.enqueue') throw Error('fixture');
  changed.command.input.content = 'different';
  assert.notEqual(operationIdentity(changed).inputDigest, identity.inputDigest);
  changed.principal = { kind: 'user', userId: 'other', authSessionHash: 'AUTH' };
  assert.notEqual(operationIdentity(changed).ownerKey, identity.ownerKey);
  changed.storeId = 'other-store';
  assert.notEqual(operationIdentity(changed).storeId, identity.storeId);
});

test('strict command schema, caller restrictions and runtime target matching fail closed', () => {
  assert.equal(parseCommandEnvelope(enqueue()).command.name, 'turn.enqueue');
  const background = enqueue();
  background.principal = { kind: 'system', purpose: 'scheduler' };
  rejects(() => parseCommandEnvelope(background), 'FORBIDDEN');
  if (background.command.name !== 'turn.enqueue') throw Error('fixture');
  background.command.input.origin = { kind: 'followup', followupId: 'followup' };
  assert.equal(parseCommandEnvelope(background).command.name, 'turn.enqueue');
  rejects(() => parseCommandEnvelope({ ...enqueue(), sql: 'PRIVATE SQL' }), 'INVALID_ARGUMENT');
  rejects(() => parseCommandEnvelope({ ...enqueue(), protocolVersion: 2 }), 'INVALID_ARGUMENT');
  rejects(() => parseCommandEnvelope(enqueue(), 10), 'PAYLOAD_TOO_LARGE');
  const request = { ...enqueue(), command: { name: 'queue.claim', input: { resourceKey: 'codex:default', claimToken: 'claim' } } };
  rejects(() => parseCommandEnvelope(request), 'FORBIDDEN');
  request.principal = { kind: 'system', purpose: 'maintenance' } as never;
  rejects(() => parseCommandEnvelope(request), 'FORBIDDEN');
  request.principal = { kind: 'system', purpose: 'scheduler' } as never;
  assert.equal(parseCommandEnvelope(request).command.name, 'queue.claim');
  const runtime = { ...enqueue(), principal: { kind: 'runtime', sessionId: 'session', attemptId: 'attempt', connectionId: 'conn', runtimeVersion: 1 },
    command: { name: 'turn.updateUsage', input: { sessionId: 'other', attemptId: 'attempt', usage: null } } };
  rejects(() => parseCommandEnvelope(runtime), 'FORBIDDEN');
  runtime.command.input.sessionId = 'session';
  assert.equal(parseCommandEnvelope(runtime).command.name, 'turn.updateUsage');
});

test('fact boundary accepts process_exit but rejects content disguised as a fact payload', () => {
  const request = { ...enqueue(), principal: { kind: 'runtime', sessionId: 'session', attemptId: 'attempt', connectionId: 'conn', runtimeVersion: 1 },
    command: { name: 'turn.appendFact', input: { fact: {
      id: 'fact', sessionId: 'session', attemptId: 'attempt', engineId: 'codex', connectionId: 'conn',
      factType: 'connection_closed', source: 'process_exit', sequence: 1, idempotencyKey: 'fact', observedAt: 1,
      payload: { errorCode: 'ENGINE_CLOSED' } as Record<string, unknown>,
    } } } };
  assert.equal(parseCommandEnvelope(request).command.name, 'turn.appendFact');
  request.command.input.fact.payload = { content: 'PRIVATE_BODY' };
  rejects(() => parseCommandEnvelope(request), 'INVALID_ARGUMENT');
});

test('terminal cannot confirm completed without content or mix external turn identities', () => {
  const request = { ...enqueue(), principal: { kind: 'system', purpose: 'recovery' }, command: {
    name: 'turn.projectTerminal', input: { decision: { id: 'decision', sessionId: 'session', attemptId: 'attempt', engineId: 'codex',
      outcome: 'completed', reasonCode: 'COMPLETED', factId: 'fact', decidedAt: 1, projectedAt: null, externalTurnId: 'turn' },
    message: { id: 'message', turnId: 'turn', content: ' ', items: null, metadata: null, durationMs: 1 } },
  } };
  rejects(() => parseCommandEnvelope(request), 'INVALID_ARGUMENT');
  request.command.input.message.content = 'result'; request.command.input.message.turnId = 'other';
  rejects(() => parseCommandEnvelope(request), 'INVALID_ARGUMENT');
  request.command.input.message.turnId = 'turn';
  assert.equal(parseCommandEnvelope(request).command.name, 'turn.projectTerminal');
});

test('lost reply stays unknown until the queue owner certifies non-execution', () => {
  for (const cause of ['deadline', 'worker-exit', 'transport'] as const) {
    assert.deepEqual(lostReply('operation', 'may-have-executed', cause), {
      state: 'unknown', operationId: 'operation', cause, recovery: 'lookup',
    });
  }
  assert.deepEqual(lostReply('operation', 'cancelled-before-execution', 'deadline'), {
    state: 'rejected', operationId: 'operation', code: 'NOT_SUBMITTED',
  });
});
