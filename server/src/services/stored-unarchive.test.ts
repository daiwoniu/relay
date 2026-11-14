import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { StoredUnarchiveService } from './stored-unarchive.js';
import { createStoredUnarchiveRouter } from '../routes/stored-unarchive.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';
import type { StorageCommandEnvelope } from '../storage/contracts.js';
const session = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const principal = (id = 'owner') => ({ kind: 'user' as const, userId: id, authSessionHash: hashSessionToken(`synthetic-unarchive-${id}`) });
async function prepared() {
  const f = fixture();
  f.mutate(`INSERT INTO sessions(id,owner_user_id,project_id,status,engine,engine_bound,codex_thread_id,engine_session_id,message_revision,codex_archived)
    VALUES('${session}','owner','project','completed','codex',1,'unarchive-thread','unarchive-thread',0,1)`);
  for (const id of ['owner','other','admin']) f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now()+600_000})`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const state = { archived: true, calls: 0, closed: 0, notifications: 0, connection: {} as object | null };
  const hooks = {
    unarchive: async (_id: string, mayDispatch: () => Promise<boolean>) => { if (!await mayDispatch()) throw new Error('FENCED'); state.calls++; state.archived = false; },
    verify: async (_id: string): Promise<boolean | null> => state.archived,
    close: async (_id: string, _thread: string, mayClose: () => Promise<boolean>) => {
      const current = state.connection; if (current && await mayClose() && state.connection === current) { state.closed++; state.connection = null; }
    }, changed: async (_id: string) => { state.notifications++; },
  };
  const createService = () => new StoredUnarchiveService({ port, storeId: 'store', generation: 1,
    unarchiveThread: (...args) => hooks.unarchive(...args), isThreadArchived: (...args) => hooks.verify(...args),
    closeIdleConnection: (...args) => hooks.close(...args), changed: (...args) => hooks.changed(...args) });
  const service = createService();
  const app = new Hono().route('/api', createStoredUnarchiveRouter({ port, service, assertNotDeleting: () => {} }));
  const request = (user = 'owner', operation = key) => app.request(`/api/sessions/${session}/unarchive`, { method: 'POST',
    headers: { cookie: serializeSessionCookie(`synthetic-unarchive-${user}`, Date.now()+600_000, false), 'x-relay-operation-id': operation } });
  return { f, port, state, hooks, service, createService, app, request, cleanup: async () => { await port.close(); f.cleanup(); } };
}
test('unarchive prepares, dispatches once and commits without replacing the last terminal status; retries read current state', async () => {
  const p = await prepared();
  try {
    const response = await p.request(); assert.equal(response.status, 200); const body = await response.json() as any;
    assert.equal(body.session.codex_archived, false); assert.equal(body.session.status, 'completed');
    assert.equal(p.state.calls, 1); assert.equal(p.state.closed, 1); assert.equal(p.f.scalar('SELECT phase FROM _relay_external_operations'), 'applied');
    assert.equal((await p.request()).status, 200); assert.equal(p.state.calls, 1); assert.equal(p.state.closed, 1);
    assert.equal((await p.request('owner', randomUUID())).status, 200); assert.equal(p.state.calls, 1); // New intent verifies the already-desired remote state.
    assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'), 1); // Existing unrelated runtime remains alive.
  } finally { await p.cleanup(); }
});
test('shutdown waits for a timed-out unarchive RPC and recovery verifies its result without resending',async()=>{
  const p=await prepared();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const service=new StoredUnarchiveService({port:p.port,storeId:'store',generation:1,externalTimeoutMs:10,
    isThreadArchived:async()=>p.state.archived,unarchiveThread:async(_id,mayDispatch)=>{assert.equal(await mayDispatch(),true);p.state.calls++;entered();await gate;p.state.archived=false;},closeIdleConnection:async()=>{},changed:async()=>{}});
  try{
    const work=service.run(principal(),session,key);await started;assert.deepEqual(await work,{state:'unknown'});
    let closed=false;const closing=service.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(closed,false);
    release();await closing;assert.equal(p.state.calls,1);await assert.rejects(service.run(principal(),session,key),/NOT_SUBMITTED/);
    assert.equal((await p.createService().run(principal(),session,key)).state,'committed');assert.equal(p.state.calls,1);
  }finally{release();await service.close();await p.cleanup();}
});
test('concurrent same-intent requests coalesce and ambiguous dispatch is verified rather than repeated after a service restart', async () => {
  const p = await prepared();
  try {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    p.hooks.unarchive = async (_id, mayDispatch) => { assert.equal(await mayDispatch(), true); p.state.calls++; await gate; throw new Error('private transport ambiguity'); };
    const first = p.service.run(principal(), session, key), same = p.service.run(principal(), session, key); assert.equal(first, same);
    release(); assert.deepEqual(await first, { state: 'unknown' }); assert.equal(p.state.calls, 1);
    assert.equal(p.f.scalar('SELECT phase FROM _relay_external_operations'), 'dispatched');
    const restarted = p.createService(); assert.deepEqual(await restarted.run(principal(), session, key), { state: 'unknown' }); assert.equal(p.state.calls, 1);
    p.state.archived = false; const confirmed = await restarted.run(principal(), session, key);
    assert.equal(confirmed.state, 'committed'); assert.equal(p.state.calls, 1);
  } finally { await p.cleanup(); }
});
test('lost replies recover exact phase receipts; failed finish transaction keeps started audit and fences old archive snapshots once confirmed', async () => {
  const p = await prepared();
  try {
    const begun = await p.port.execute<'archive.beginSnapshot'>({ protocolVersion: 1, storeId: 'store', workerGeneration: 1, requestId: 'begin', operationId: 'old-snapshot',
      principal: { kind: 'system', purpose: 'maintenance' }, command: { name: 'archive.beginSnapshot', input: {} } });
    assert.equal(begun.state, 'committed');
    p.f.mutate("CREATE TRIGGER fail_finish BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='session.finishUnarchive' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    const first = await p.service.run(principal('admin'), session, key); assert.equal(first.state, 'unknown'); assert.equal(p.state.calls, 1);
    assert.equal(p.f.scalar(`SELECT codex_archived FROM sessions WHERE id='${session}'`), 1);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='started'"), 1);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='failed'"), 0);
    p.f.mutate('DROP TRIGGER fail_finish');
    const execute = p.port.execute.bind(p.port);
    p.port.execute = (async (request: StorageCommandEnvelope) => { const result = await execute(request);
      return result.state === 'committed' ? { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' } : result;
    }) as typeof p.port.execute;
    assert.equal((await p.service.run(principal('admin'), session, key)).state, 'committed'); assert.equal(p.state.calls, 1);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"), 1);
    const stale = await execute({ protocolVersion: 1, storeId: 'store', workerGeneration: 1, requestId: 'stale', operationId: 'stale-apply',
      principal: { kind: 'system', purpose: 'maintenance' }, command: { name: 'archive.applySnapshot', input: { version: 1, archivedThreadIds: ['unarchive-thread'] } } });
    assert.equal(stale.state, 'rejected'); if (stale.state === 'rejected') assert.equal(stale.code, 'SUPERSEDED');
    assert.equal(p.f.scalar(`SELECT codex_archived FROM sessions WHERE id='${session}'`), 0);
  } finally { await p.cleanup(); }
});
test('source changes or a newly running attempt after external completion cannot be reset or closed', async () => {
  const p = await prepared();
  try {
    p.hooks.unarchive = async (_id, mayDispatch) => { assert.equal(await mayDispatch(), true); p.state.calls++; p.state.archived = false;
      p.f.mutate(`UPDATE sessions SET status='processing',active_attempt_id='new-attempt' WHERE id='${session}';
        INSERT INTO engine_resource_leases VALUES('new-attempt','${session}','new-lease','running','codex','codex:default',1,1)`); };
    const result = await p.service.run(principal(), session, key); assert.equal(result.state, 'unknown');
    assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${session}'`), 'processing');
    assert.equal(p.f.scalar(`SELECT active_attempt_id FROM sessions WHERE id='${session}'`), 'new-attempt'); assert.equal(p.state.closed, 0);
    assert.equal(p.f.scalar('SELECT phase FROM _relay_external_operations'), 'dispatched');
  } finally { await p.cleanup(); }
});
test('authorization is rechecked after asynchronous provider setup and after an external effect', async () => {
  const p = await prepared();
  try {
    p.hooks.unarchive = async (_id, mayDispatch) => { p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");
      if (!await mayDispatch()) throw new Error('FENCED'); p.state.calls++; };
    assert.equal((await p.service.run(principal(), session, key)).state, 'unknown'); assert.equal(p.state.calls, 0);
    assert.equal(p.state.closed, 0);
    p.f.mutate("UPDATE users SET disabled_at=NULL WHERE id='owner'");
    p.state.archived = false; // A read-only verification is enough to complete the pending desired state.
    assert.equal((await p.service.run(principal(), session, key)).state, 'committed'); assert.equal(p.state.calls, 0);
    const second = randomUUID(); p.state.archived = true; p.f.mutate(`UPDATE sessions SET codex_archived=1 WHERE id='${session}'`);
    p.hooks.unarchive = async (_id, mayDispatch) => { assert.equal(await mayDispatch(), true); p.state.calls++; p.state.archived = false; p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'"); };
    assert.equal((await p.service.run(principal(), session, second)).state, 'unknown');
    assert.equal(p.f.scalar(`SELECT codex_archived FROM sessions WHERE id='${session}'`), 1);
  } finally { await p.cleanup(); }
});
test('unarchive HTTP preserves origin, account and owner gates without exposing provider details', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.app.request(`/api/sessions/${session}/unarchive`, { method: 'POST' })).status, 401);
    assert.equal((await p.request('other')).status, 404); assert.equal(p.state.calls, 0);
    assert.equal((await p.request('owner', 'invalid')).status, 400);
    assert.equal((await p.app.request(`/api/sessions/${session}/unarchive`, { method: 'POST', headers: { cookie: serializeSessionCookie('synthetic-unarchive-owner', Date.now()+600_000, false), origin: 'https://untrusted.invalid' } })).status, 403);
    p.hooks.unarchive = async () => { p.state.calls++; throw new Error('private provider token detail'); };
    const unknown = await p.request(); assert.equal(unknown.status, 503); const body = await unknown.json() as any;
    assert.equal(body.code, 'EXTERNAL_RESULT_UNKNOWN'); assert.equal(JSON.stringify(body).includes('private provider'), false);
    p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'"); assert.equal((await p.request()).status, 403);
  } finally { await p.cleanup(); }
});
test('known commit keeps its outcome when projections/notifications fail, and idle-close callbacks cannot close a newer attempt', async () => {
  const p = await prepared(); const warn = console.warn; const warnings: unknown[] = []; console.warn = (...values) => { warnings.push(values); };
  try {
    p.hooks.close = async (_id, _thread, mayClose) => { p.f.mutate(`UPDATE sessions SET status='processing',active_attempt_id='later' WHERE id='${session}'`); assert.equal(await mayClose(), false); };
    p.hooks.changed = async () => { throw new Error('private notification'); };
    p.port.readSession = async () => { throw new Error('private projection'); };
    const response = await p.request(); assert.equal(response.status, 503); assert.equal((await response.json() as any).code, 'RESOURCE_STATE_UNAVAILABLE');
    assert.equal(p.f.scalar(`SELECT codex_archived FROM sessions WHERE id='${session}'`), 0); assert.equal(p.state.closed, 0);
    assert.equal(JSON.stringify(warnings).includes('private notification'), false);
  } finally { console.warn = warn; await p.cleanup(); }
});
