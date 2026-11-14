import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs, CoreCommandName, CoreCommandOutputs } from './contracts.js';

const principal = (userId = 'owner') => ({ kind: 'user' as const, userId, authSessionHash: `auth-${userId}` });
async function prepared() {
  const f = fixture();
  f.mutate("UPDATE sessions SET status='idle',codex_thread_id='parent-thread',active_attempt_id=NULL WHERE id='session'; DELETE FROM engine_resource_leases");
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  let seq = 0;
  const command = async <K extends CoreCommandName>(name: K, input: CoreCommandInputs[K], actor = 'owner', operationId = `fork-${++seq}`) => port.execute({
    protocolVersion: 1, storeId: 'store', workerGeneration: 1, requestId: operationId, operationId, principal: principal(actor), command: { name, input } } as any);
  const commit = async <K extends CoreCommandName>(name: K, input: CoreCommandInputs[K], actor = 'owner', operationId?: string): Promise<CoreCommandOutputs[K]> => {
    const result = await command(name, input, actor, operationId); assert.equal(result.state, 'committed', JSON.stringify(result));
    return (result as any).value;
  };
  const begin = (actor = 'owner', messageId: string | null = null) => commit('session.prepareFork', { sessionId: 'session', messageId }, actor);
  return { f, port, command, commit, begin, cleanup: async () => { await port.close(); f.cleanup(); } };
}
test('fork preparation, exclusive claim, acknowledged child and final copy are durable and idempotent', async () => {
  const p = await prepared();
  try {
    const begin = await p.begin(), scope = { sessionId: 'session', externalOperationId: begin.externalOperationId };
    assert.equal(p.f.scalar('SELECT count(*) FROM sessions'), 1);
    assert.equal((await p.begin()).externalOperationId, begin.externalOperationId);
    const claim = await p.commit('session.claimFork', scope); assert.equal(claim.claimed, true);
    assert.equal((await p.commit('session.claimFork', scope)).claimed, false);
    assert.equal((await p.command('session.finishFork', { ...scope, uploads: [] })).state, 'rejected');
    await p.commit('session.acknowledgeFork', { ...scope, childId: 'new-child', claimToken: claim.claimToken! });
    assert.equal((await p.port.readForkPlan({ ...scope, principal: principal(), after: -1 })).childId, 'new-child');
    const finished = await p.commit('session.finishFork', { ...scope, uploads: [] }, 'owner', 'finish');
    assert.equal(finished.forkedSessionId, begin.forkedSessionId);
    assert.equal(p.f.scalar(`SELECT engine_session_id FROM sessions WHERE id='${finished.forkedSessionId}'`), 'new-child');
    assert.equal(p.f.scalar(`SELECT count(*) FROM messages WHERE session_id='${finished.forkedSessionId}'`), 2);
    assert.equal((await p.port.lookup({ storeId: 'store', operationId: 'finish', principal: principal() })).state, 'committed');
    assert.equal((await p.commit('session.finishFork', { ...scope, uploads: [] })).forkedSessionId, finished.forkedSessionId);
    assert.equal(p.f.scalar('SELECT count(*) FROM sessions'), 2);
    const receipt = await p.command('session.acknowledgeFork', { ...scope, childId: 'different-child', claimToken: claim.claimToken! });
    assert.equal(receipt.state, 'rejected');
  } finally { await p.cleanup(); }
});
test('source edits, wrong actor, missing parent and loss of admin authority block pending fork stages', async () => {
  const p = await prepared();
  try {
    const begin = await p.begin('admin'), scope = { sessionId: 'session', externalOperationId: begin.externalOperationId };
    await assert.rejects(p.port.readForkPlan({ ...scope, principal: principal(), after: -1 }), { code: 'FORBIDDEN' });
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    assert.equal((await p.command('session.claimFork', scope, 'admin')).state, 'rejected');
    p.f.mutate("UPDATE users SET role='admin' WHERE id='admin'; UPDATE messages SET content='changed' WHERE id='m1'");
    assert.equal((await p.command('session.claimFork', scope, 'admin')).state, 'rejected');
    p.f.mutate("UPDATE messages SET content='first' WHERE id='m1'; UPDATE projects SET deleted_at=1 WHERE id='project'");
    assert.equal((await p.command('session.claimFork', scope, 'admin')).state, 'rejected');
    assert.equal(p.f.scalar('SELECT count(*) FROM sessions'), 1);
  } finally { await p.cleanup(); }
});
test('anchored completed prefix survives later appends; latest forks reject running sources', async () => {
  const p = await prepared();
  try {
    p.f.mutate("UPDATE sessions SET status='processing' WHERE id='session'");
    assert.equal((await p.command('session.prepareFork', { sessionId: 'session', messageId: null })).state, 'rejected');
    const begin = await p.begin('owner', 'm1'), scope = { sessionId: 'session', externalOperationId: begin.externalOperationId };
    p.f.mutate("INSERT INTO messages(id,session_id,turn_id,role,content,created_at,stopped) VALUES('m3','session','next','user','later',3,0); UPDATE sessions SET message_revision=3 WHERE id='session'");
    const claim = await p.commit('session.claimFork', scope); await p.commit('session.acknowledgeFork', { ...scope, childId: 'anchored-child', claimToken: claim.claimToken! });
    const result = await p.commit('session.finishFork', { ...scope, uploads: [] });
    assert.equal(p.f.scalar(`SELECT count(*) FROM messages WHERE session_id='${result.forkedSessionId}'`), 1);
    assert.equal(p.f.scalar(`SELECT content FROM messages WHERE session_id='${result.forkedSessionId}'`), 'first');
  } finally { await p.cleanup(); }
});
test('admin destination project and fork rollback together when receipt insertion fails', async () => {
  const p = await prepared();
  try {
    const begin = await p.begin('admin'), scope = { sessionId: 'session', externalOperationId: begin.externalOperationId };
    const claim = await p.commit('session.claimFork', scope, 'admin'); await p.commit('session.acknowledgeFork', { ...scope, childId: 'admin-child', claimToken: claim.claimToken! }, 'admin');
    assert.equal(p.f.scalar('SELECT count(*) FROM projects'), 1);
    p.f.mutate("CREATE TRIGGER reject_fork_receipt BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='session.finishFork' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.notEqual((await p.command('session.finishFork', { ...scope, uploads: [] }, 'admin')).state, 'committed');
    assert.equal(p.f.scalar('SELECT count(*) FROM projects'), 1); assert.equal(p.f.scalar('SELECT count(*) FROM sessions'), 1);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='session.fork_from' AND result='succeeded'"), 0);
    p.f.mutate('DROP TRIGGER reject_fork_receipt');
    const result = await p.commit('session.finishFork', { ...scope, uploads: [] }, 'admin');
    assert.equal(p.f.scalar(`SELECT owner_user_id FROM projects WHERE id='${result.projectId}'`), 'admin');
    assert.equal(p.f.scalar(`SELECT owner_user_id FROM sessions WHERE id='${result.forkedSessionId}'`), 'admin');
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='session.fork_from' AND result='succeeded'"), 1);
  } finally { await p.cleanup(); }
});
