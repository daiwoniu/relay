import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './storage-fixture.test-support.js';
import { NativeStore } from './native-store.js';

const sessionId = '22222222-2222-4222-8222-222222222222';
const principal = { kind: 'user' as const, userId: 'owner', authSessionHash: 'auth-owner' };
test('historical message DTOs expose only a unique same-session engine-to-request association', () => {
  const f = fixture();
  f.mutate(`INSERT INTO sessions(id,owner_user_id,project_id,status,message_revision,engine,engine_bound) VALUES('${sessionId}','owner','project','idle',2,'codex',1);
    UPDATE messages SET session_id='${sessionId}';
    INSERT INTO engine_turn_facts(id,session_id,attempt_id,engine,connection_id,external_turn_id,fact_type,source,sequence,idempotency_key,observed_at,safe_payload_json,created_at)
      VALUES('fact-link','${sessionId}','request','codex','connection','turn','final_answer_completed','realtime',1,'link-key',3,'{}',3);
    INSERT INTO engine_terminal_decisions(id,session_id,attempt_id,engine,external_turn_id,outcome,reason_code,fact_id,decided_at)
      VALUES('decision-link','${sessionId}','request','codex','turn','completed','completed','fact-link',3)`);
  const store = new NativeStore(f.filename, 'store', 1, true);
  try {
    const page = store.readMessagePage({ principal, sessionId, limit: 50, before: null, knownRevision: null });
    assert(!page.unchanged); assert.equal(page.page.messages[0].requestTurnId, 'request');
    const offset = store.readMessagesOffset({ principal, sessionId, limit: 50, offset: 0, includeDetails: false });
    assert.equal(offset[0].requestTurnId, 'request'); assert.equal(offset[0].turn_id, 'turn');
    f.mutate(`INSERT INTO engine_terminal_decisions(id,session_id,attempt_id,engine,external_turn_id,outcome,reason_code,fact_id,decided_at)
      VALUES('decision-ambiguous','${sessionId}','other-request','codex','turn','completed','completed','fact-link',4)`);
    assert.equal(store.readMessagesOffset({ principal, sessionId, limit: 50, offset: 0, includeDetails: false })[0].requestTurnId, undefined);
    f.mutate("UPDATE messages SET session_id='session'");
    assert.equal(store.readMessagesOffset({ principal, sessionId: 'session', limit: 50, offset: 0, includeDetails: false })[0].requestTurnId, undefined);
    assert.throws(() => store.readMessagesOffset({ principal: { ...principal, userId: 'other', authSessionHash: 'auth-other' }, sessionId, limit: 50, offset: 0, includeDetails: false }), { code: 'FORBIDDEN' });
  } finally { store.close(); f.cleanup(); }
});
