import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs, StorageCommandEnvelope } from './contracts.js';

function enqueue(id = 'followup'): StorageCommandEnvelope & { command: { name: 'turn.enqueue'; input: CoreCommandInputs['turn.enqueue'] } } {
  return { ...markRead(), operationId: `enqueue:${id}`, principal: { kind: 'system', purpose: 'scheduler' },
    command: { name: 'turn.enqueue', input: { sessionId: 'session', attemptId: `attempt:${id}`, messageId: id,
      engineId: 'codex', resourceKey: 'codex:default', content: 'next', metadata: null,
      expectedPreferencesRevision: 0, origin: { kind: 'followup', followupId: id } } } };
}
function seed(f: ReturnType<typeof fixture>) {
  f.mutate(`DELETE FROM engine_resource_leases;
    UPDATE sessions SET status='completed',active_attempt_id=NULL;
    INSERT INTO session_followups(id,session_id,user_id,content,attachments_json,state,created_at,updated_at)
      VALUES('followup','session','owner',' next ','[]','queued',10,10);`);
}

test('followup consumption, message, queue and receipt commit once and survive a new Worker', async () => {
  const f = fixture(); seed(f);
  let port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const first = await port.execute(enqueue()); assert.equal(first.state, 'committed');
    assert.equal(f.scalar("SELECT state FROM session_followups WHERE id='followup'"), 'delivered');
    assert.equal(f.scalar('SELECT requested_by_user_id FROM engine_queue_entries'), 'owner');
    assert.equal(f.scalar("SELECT content FROM messages WHERE id='followup'"), 'next');
    await port.close();
    port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 2 });
    const replay = await port.execute({ ...enqueue(), workerGeneration: 2 });
    assert.equal(replay.state, 'committed'); if (replay.state === 'committed') assert.equal(replay.replayed, true);
    assert.equal(f.scalar('SELECT count(*) FROM engine_queue_entries'), 1);
    assert.equal(f.scalar("SELECT count(*) FROM messages WHERE id='followup'"), 1);
  } finally { await port.close(); f.cleanup(); }
});

test('receipt failure rolls back followup consumption and permits a safe receipt-checked retry', async () => {
  const f = fixture(); seed(f);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    f.mutate("CREATE TRIGGER fail_receipt BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await port.execute(enqueue())).state, 'unknown');
    assert.deepEqual(await port.lookup({ storeId: 'store', operationId: enqueue().operationId, principal: enqueue().principal }), { state: 'not-found' });
    assert.equal(f.scalar('SELECT state FROM session_followups'), 'queued');
    assert.equal(f.scalar('SELECT count(*) FROM engine_queue_entries'), 0);
    assert.equal(f.scalar("SELECT count(*) FROM messages WHERE id='followup'"), 0);
    f.mutate('DROP TRIGGER fail_receipt');
    assert.equal((await port.execute(enqueue())).state, 'committed');
  } finally { await port.close(); f.cleanup(); }
});

test('FIFO blockers, altered content, disabled authors, trash and unprepared attachments cannot be consumed', async () => {
  const f = fixture(); seed(f);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const rejected = async (request = enqueue(), code = 'CONFLICT') => {
    assert.deepEqual(await port.execute(request), { state: 'rejected', operationId: request.operationId, code });
    assert.equal(f.scalar("SELECT state FROM session_followups WHERE id='followup'"), 'queued');
    assert.equal(f.scalar('SELECT count(*) FROM engine_queue_entries'), 0);
  };
  try {
    const altered = enqueue(); altered.command.input.content = 'altered'; await rejected(altered);
    const metadata = enqueue(); metadata.command.input.metadata = { replyToAsyncQuestionId: 'async-question:spoof' }; await rejected(metadata);
    f.mutate("INSERT INTO session_followups(id,session_id,user_id,content,attachments_json,state,created_at,updated_at) VALUES('block','session','owner','first','[]','uncertain',1,1)");
    await rejected(); f.mutate("UPDATE session_followups SET state='cancelled' WHERE id='block'");
    f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'"); await rejected(enqueue(), 'FORBIDDEN');
    f.mutate("UPDATE users SET disabled_at=NULL WHERE id='owner'; UPDATE projects SET deleted_at=1"); await rejected(enqueue(), 'FORBIDDEN');
    f.mutate("UPDATE projects SET deleted_at=NULL; UPDATE session_followups SET attachments_json='[{}]' WHERE id='followup'"); await rejected(enqueue(), 'NOT_SUPPORTED');
    f.mutate("UPDATE session_followups SET attachments_json='[]' WHERE id='followup'");
    assert.equal((await port.execute(enqueue())).state, 'committed');
  } finally { await port.close(); f.cleanup(); }
});
