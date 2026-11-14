import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createStoredProjectMembersRouter } from './stored-project-members.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';
import type { StorageCommandEnvelope } from '../storage/contracts.js';

const project = '11111111-1111-4111-8111-111111111111';
const member = '22222222-2222-4222-8222-222222222222';
const owner = '33333333-3333-4333-8333-333333333333';
const operation = '44444444-4444-4444-8444-444444444444';
const url = `/api/projects/${project}/members`;
const cookie = (user = 'admin') => serializeSessionCookie(`synthetic-members-${user}`, Date.now()+600_000, false);
async function prepared(callback?: (projectId: string, userId: string) => void | Promise<void>) {
  const f = fixture();
  f.mutate(`INSERT INTO users(id,role,username) VALUES('${member}','member','candidate'),('${owner}','member','project-owner');
    INSERT INTO projects(id,owner_user_id,path) VALUES('${project}','${owner}','D:/members-http');
    INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES
      ('${hashSessionToken('synthetic-members-admin')}','admin',${Date.now()+600_000}),
      ('${hashSessionToken(`synthetic-members-${member}`)}','${member}',${Date.now()+600_000}),
      ('${hashSessionToken(`synthetic-members-${owner}`)}','${owner}',${Date.now()+600_000});`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const notifications: unknown[] = [];
  const app = new Hono().route('/api', createStoredProjectMembersRouter({ port, storeId: 'store', generation: 1,
    recheckProjectAccess: callback ?? ((projectId, userId) => { notifications.push({ projectId, userId,
      currentRole: f.scalar(`SELECT coalesce((SELECT role FROM project_members WHERE project_id='${projectId}' AND user_id='${userId}'),'none')`) }); }) }));
  app.get('/api/public-probe', (c) => c.text('public'));
  const request = (method = 'PUT', body: unknown = { role: 'collaborator', can_view_sessions: 1 }, key = operation, user = 'admin', target = member) => app.request(`${url}/${target}`, {
    method, headers: { cookie: cookie(user), 'content-type': 'application/json', 'x-relay-operation-id': key },
    ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}),
  });
  const get = (suffix = '', user = 'admin') => app.request(`${url}${suffix}`, { headers: { cookie: cookie(user) } });
  return { f, port, app, request, get, notifications, cleanup: async () => { await port.close(); f.cleanup(); } };
}

test('members HTTP/Worker preserves public candidates, current visibility, default repair and receipt-safe invalidation', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.app.request('/api/public-probe')).status, 200);
    assert.equal((await p.app.request(url)).status, 401);
    const candidates = await p.get('/candidates'); assert.equal(candidates.status, 200);
    const users = (await candidates.json() as any).users;
    assert.equal(users.length, 5);
    assert.equal(JSON.stringify(users).includes('password_hash'), false);
    assert.equal(JSON.stringify(users).includes('token_hash'), false);
    const first = await p.request(); assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-relay-operation-id'), operation);
    assert.deepEqual(await (await p.get()).json(), [{ user_id: member, role: 'collaborator', can_view_sessions: 1 }]);
    p.f.mutate(`UPDATE users SET default_project_id='${project}' WHERE id='${member}';
      INSERT INTO projects(id,owner_user_id,path,is_system) VALUES('fallback','${member}','D:/fallback',1)`);
    assert.equal((await p.request('PUT', { role: 'viewer' }, randomUUID())).status, 200);
    assert.equal(p.f.scalar(`SELECT default_project_id FROM users WHERE id='${member}'`), 'fallback');
    assert.deepEqual(await (await p.get()).json(), [{ user_id: member, role: 'viewer', can_view_sessions: 1 }]);
    assert.equal((await p.request('DELETE', null, randomUUID())).status, 200);
    assert.equal((await p.request()).status, 200); // Old grant is a receipt, not a new grant.
    assert.deepEqual(await (await p.get()).json(), []);
    assert.deepEqual(p.notifications.at(-1), { projectId: project, userId: member, currentRole: 'none' });
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_storage_operations'), 3);
    assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'), 3);
  } finally { await p.cleanup(); }
});

test('current Worker role, login, project and initial-password gates protect both reads and mutation', async () => {
  const p = await prepared();
  try {
    for (const user of [owner, member]) {
      assert.equal((await p.get('', user)).status, 403);
      assert.equal((await p.get('/candidates', user)).status, 403);
      assert.equal((await p.request('PUT', { role: 'manager' }, randomUUID(), user)).status, 403);
    }
    const principal = { kind: 'user' as const, userId: member, authSessionHash: hashSessionToken(`synthetic-members-${member}`) };
    await assert.rejects(p.port.listProjectMemberCandidates({ principal, projectId: project }), { code: 'FORBIDDEN' });
    assert.equal((await p.request('PUT', { role: 'viewer' }, randomUUID(), 'admin', owner)).status, 409);
    assert.equal((await p.request()).status, 200);
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    assert.equal((await p.request()).status, 403);
    await assert.rejects(p.port.readProjectMembers({ principal: { kind: 'user', userId: 'admin', authSessionHash: 'auth-admin' }, projectId: project }), { code: 'FORBIDDEN' });
    p.f.mutate("UPDATE users SET role='admin',must_change_password=1 WHERE id='admin'");
    assert.equal((await p.get()).status, 403);
    p.f.mutate("UPDATE users SET must_change_password=0 WHERE id='admin'");
    p.f.mutate(`UPDATE projects SET deleted_at=1 WHERE id='${project}'`);
    assert.equal((await p.get('/candidates')).status, 403);
    assert.equal((await p.request()).status, 403);
    p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='admin'");
    assert.equal((await p.get()).status, 401);
  } finally { await p.cleanup(); }
});

test('strict URL/body binding and origin boundaries cannot redirect membership targets', async () => {
  const p = await prepared();
  try {
    for (const body of [{ role: 'viewer', userId: owner }, { role: 'admin' }, { role: 'viewer', can_view_sessions: true }, null])
      assert.equal((await p.request('PUT', body)).status, 400);
    assert.equal((await p.request('PUT', { role: 'viewer' }, 'bad')).status, 400);
    assert.equal((await p.request('DELETE', null, randomUUID(), 'admin', 'bad')).status, 400);
    assert.equal((await p.app.request(`${url}/${member}`, { method: 'PUT', headers: { cookie: cookie(), origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, body: '{"role":"viewer"}' })).status, 403);
    assert.equal((await p.app.request(`${url}/${member}`, { method: 'PUT', headers: { cookie: cookie(), 'content-type': 'application/json' }, body: '{' })).status, 400);
    assert.equal(p.f.scalar('SELECT count(*) FROM project_members'), 0);
    assert.equal((await p.request()).status, 200);
    assert.equal((await p.request('PUT', { role: 'manager' })).status, 409);
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_storage_operations'), 1);
  } finally { await p.cleanup(); }
});

test('lost reply recovery checks the exact original intent; revoked recovery remains unknown and still rechecks', async () => {
  const p = await prepared();
  try {
    const execute = p.port.execute.bind(p.port), lookup = p.port.lookup.bind(p.port); let expected = false;
    p.port.execute = (async (request: StorageCommandEnvelope) => {
      const result = await execute(request);
      return result.state === 'committed' ? { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' } : result;
    }) as typeof p.port.execute;
    p.port.lookup = async (request) => { expected = !!request.expected?.inputDigest; return lookup(request); };
    assert.equal((await p.request()).status, 200); assert.equal(expected, true);
    p.port.execute = (async (request: StorageCommandEnvelope) => {
      await execute(request);
      p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");
      return { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' };
    }) as typeof p.port.execute;
    const response = await p.request('DELETE', null, randomUUID());
    assert.equal(response.status, 503); assert.equal((await response.json() as any).code, 'STORAGE_RESULT_UNKNOWN');
    assert.equal(p.f.scalar('SELECT count(*) FROM project_members'), 0);
    assert.equal(p.notifications.length, 2);
  } finally { await p.cleanup(); }
});

test('receipt rollback is atomic, notification errors are owned, and database outage is not logout', async () => {
  const p = await prepared(async () => { throw new Error('private callback detail'); });
  const warn = console.warn; const warnings: unknown[] = []; console.warn = (...values) => { warnings.push(values); };
  try {
    p.f.mutate("CREATE TRIGGER fail_receipt BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    const response = await p.request(); assert.equal(response.status, 503);
    assert.equal((await response.json() as any).code, 'STORAGE_RESULT_UNKNOWN');
    assert.equal(p.f.scalar('SELECT count(*) FROM project_members'), 0);
    assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'), 0);
    p.f.mutate('DROP TRIGGER fail_receipt');
    assert.equal((await p.request()).status, 200);
    assert.equal(warnings.length, 2); assert.equal(JSON.stringify(warnings).includes('private callback detail'), false);
    await p.port.close();
    const outage = await p.get(); assert.equal(outage.status, 503);
    assert.equal((await outage.json() as any).code, 'STORAGE_UNAVAILABLE');
  } finally { console.warn = warn; await p.cleanup(); }
});

test('member queries reject oversized lists and malformed stored roles instead of silently truncating', async () => {
  const p = await prepared();
  try {
    p.f.mutate(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<501)
      INSERT INTO users(id,role,username) SELECT 'bulk-'||x,'member','bulk-'||x FROM n;
      INSERT INTO project_members(project_id,user_id,role,can_view_sessions,created_at,updated_at)
      SELECT '${project}',id,'viewer',0,1,1 FROM users WHERE id LIKE 'bulk-%'`);
    for (const suffix of ['', '/candidates']) {
      const response = await p.get(suffix); assert.equal(response.status, 503);
      assert.equal((await response.json() as any).code, 'PAYLOAD_TOO_LARGE');
    }
    p.f.mutate(`DELETE FROM project_members; INSERT INTO project_members VALUES('${project}','${member}','viewer',1,1,1)`);
    assert.deepEqual(await (await p.get()).json(), [{ user_id: member, role: 'viewer', can_view_sessions: 1 }]);
    await assert.rejects(p.port.readProjectMembers({ principal: { kind: 'user', userId: 'admin', authSessionHash: 'auth-admin' }, projectId: project, extra: true } as any), { code: 'INVALID_ARGUMENT' });
    p.f.mutate(`PRAGMA ignore_check_constraints=ON; UPDATE project_members SET role='unexpected' WHERE user_id='${member}'`);
    const corrupt = await p.get(); assert.equal(corrupt.status, 503);
    assert.equal((await corrupt.json() as any).code, 'STORAGE_UNAVAILABLE');
  } finally { await p.cleanup(); }
});
