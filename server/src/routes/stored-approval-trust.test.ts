import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createStoredApprovalTrustRouter } from './stored-approval-trust.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';
import type { ApprovalTrustUpdatedEvent } from '../contracts/index.js';
import type { CommandResult, CoreCommandName, StorageCommandEnvelope } from '../storage/contracts.js';

const project = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const operation = '33333333-3333-4333-8333-333333333333';
const url = `/api/projects/${project}/approval-trust`;
const cookie = (user = 'owner') => serializeSessionCookie(`synthetic-${user}-http`, Date.now()+600_000, false);
async function prepared(broadcast?: (event: ApprovalTrustUpdatedEvent, userId: string) => void | Promise<void>) {
  const f = fixture();
  f.mutate(`INSERT INTO projects(id,owner_user_id,path,deleted_at) VALUES('${project}','owner','D:/http-test',NULL);
    INSERT INTO sessions(id,owner_user_id,project_id,deleted_at) VALUES('${session}','owner','${project}',NULL);
    INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES
      ('${hashSessionToken('synthetic-owner-http')}','owner',${Date.now()+600_000}),
      ('${hashSessionToken('synthetic-other-http')}','other',${Date.now()+600_000})`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const events: Array<{ event: ApprovalTrustUpdatedEvent; userId: string }> = [];
  const app = new Hono().route('/api', createStoredApprovalTrustRouter({ port, storeId: 'store', generation: 1,
    broadcast: broadcast ?? ((event, userId) => { events.push({ event, userId }); }) }));
  app.get('/api/public-probe', (c) => c.text('public'));
  const put = (key = operation, duration = 'one_hour') => app.request(url, { method: 'PUT', headers: {
    cookie: cookie(), 'content-type': 'application/json', 'x-relay-operation-id': key }, body: JSON.stringify({ duration }) });
  return { f, port, app, events, put, cleanup: async () => { await port.close(); f.cleanup(); } };
}

test('real HTTP/Worker writes await commit and return current state instead of restoring an old receipt snapshot', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.app.request('/api/public-probe')).status, 200);
    assert.equal((await p.app.request(url)).status, 401);
    const first = await p.put(); assert.equal(first.status, 200); assert.equal(first.headers.get('x-relay-operation-id'), operation);
    assert.equal((await first.json() as any).effective.trusted, true);
    const stamp = p.f.scalar('SELECT updated_at FROM approval_trust_settings');
    assert.equal((await p.put()).status, 200); assert.equal(p.f.scalar('SELECT updated_at FROM approval_trust_settings'), stamp);
    const removed = await p.app.request(url, { method: 'DELETE', headers: { cookie: cookie() } });
    assert.equal(removed.status, 200);
    const old = await p.put(); assert.equal(old.status, 200); assert.equal((await old.json() as any).effective.trusted, false);
    assert.equal(p.f.scalar('SELECT count(*) FROM approval_trust_settings'), 0);
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_storage_operations'), 2);
    assert.equal(p.events.length, 4);
    assert.deepEqual(p.events[0], { userId: 'owner', event: { type: 'approval_trust_updated', scope: 'project', scopeId: project } });
  } finally { await p.cleanup(); }
});

test('session HTTP manual override and clear preserve project inheritance', async () => {
  const p = await prepared();
  try {
    await p.put();
    const path = `/api/sessions/${session}/approval-trust`;
    const manual = await p.app.request(path, { method: 'PUT', headers: { cookie: cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'manual', duration: 'permanent' }) });
    assert.equal(manual.status, 200);
    const state = await manual.json() as any;
    assert.equal(state.effective.trusted, false); assert.equal(state.effective.sessionOverridesProject, true);
    const cleared = await p.app.request(path, { method: 'DELETE', headers: { cookie: cookie() } });
    assert.equal(cleared.status, 200); assert.equal((await cleared.json() as any).effective.source, 'project_trust');
  } finally { await p.cleanup(); }
});

test('lost commit reply is recovered with exact input digest and conflicting operation reuse is rejected', async () => {
  const p = await prepared();
  try {
    const execute = p.port.execute.bind(p.port); const lookup = p.port.lookup.bind(p.port); let expected = false;
    p.port.execute = (async (request: StorageCommandEnvelope) => {
      const result = await execute(request);
      return result.state === 'committed' ? { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' } : result;
    }) as typeof p.port.execute;
    p.port.lookup = async (request) => { expected = !!request.expected?.inputDigest; return lookup(request); };
    const result = await p.put(); assert.equal(result.status, 200); assert.equal(expected, true);
    const before = p.f.scalar('SELECT expires_at FROM approval_trust_settings');
    assert.equal((await p.put(operation, 'permanent')).status, 409);
    assert.equal(p.f.scalar('SELECT expires_at FROM approval_trust_settings'), before);
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_storage_operations'), 1);
  } finally { await p.cleanup(); }
});

test('HTTP boundaries retain account-private settings, password gate, strict input and outage semantics', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.app.request(url, { headers: { cookie: cookie('other') } })).status, 404);
    p.f.mutate(`INSERT INTO project_members VALUES('${project}','other','viewer',1,1,1)`);
    const own = await p.app.request(url, { headers: { cookie: cookie('other') } }); assert.equal(own.status, 200);
    assert.equal((await own.json() as any).effective.trusted, false);
    assert.equal((await p.app.request(`/api/sessions/${session}/approval-trust`, { headers: { cookie: cookie('other') } })).status, 404);
    const spoof = await p.app.request(url, { method: 'PUT', headers: { cookie: cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ duration: 'permanent', ownerUserId: 'other' }) });
    assert.equal(spoof.status, 400); assert.equal((await p.put('invalid-key')).status, 400);
    p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'");
    assert.equal((await p.put()).status, 403);
    await p.port.close();
    const outage = await p.app.request(url, { headers: { cookie: cookie() } });
    assert.equal(outage.status, 503); assert.equal((await outage.json() as any).code, 'STORAGE_UNAVAILABLE');
  } finally { await p.cleanup(); }
});

test('unknown rollback and post-commit refresh/notification failures preserve distinct outcomes', async () => {
  const p = await prepared(async () => { throw new Error('synthetic notification detail'); });
  const warn = console.warn; const warnings: unknown[] = []; console.warn = (...values) => { warnings.push(values); };
  try {
    p.f.mutate("CREATE TRIGGER fail_trust BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    const unknown = await p.put(); assert.equal(unknown.status, 503); assert.equal((await unknown.json() as any).code, 'STORAGE_RESULT_UNKNOWN');
    assert.equal(p.f.scalar('SELECT count(*) FROM approval_trust_settings'), 0);
    p.f.mutate('DROP TRIGGER fail_trust');
    assert.equal((await p.put()).status, 200); assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(warnings).includes('synthetic notification detail'), false);
    p.port.readApprovalTrust = async () => { throw new Error('synthetic private query error'); };
    const saved = await p.app.request(url, { method: 'DELETE', headers: { cookie: cookie() } });
    assert.equal(saved.status, 503); assert.equal((await saved.json() as any).code, 'APPROVAL_TRUST_STATE_UNAVAILABLE');
    assert.equal(p.f.scalar('SELECT count(*) FROM approval_trust_settings'), 0);
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_storage_operations'), 2);
  } finally { console.warn = warn; await p.cleanup(); }
});

test('authority lost during receipt recovery leaves HTTP result unknown although the database committed', async () => {
  const p = await prepared();
  try {
    const execute = p.port.execute.bind(p.port);
    p.port.execute = (async (request: StorageCommandEnvelope): Promise<CommandResult<CoreCommandName>> => {
      const result = await execute(request); assert.equal(result.state, 'committed');
      p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");
      return { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' };
    }) as typeof p.port.execute;
    const result = await p.put(); assert.equal(result.status, 503); assert.equal((await result.json() as any).code, 'STORAGE_RESULT_UNKNOWN');
    assert.equal(p.f.scalar('SELECT count(*) FROM approval_trust_settings'), 1); assert.equal(p.events.length, 0);
  } finally { await p.cleanup(); }
});
