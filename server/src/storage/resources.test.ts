import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';

const principal = (id = 'owner') => ({ kind: 'user' as const, userId: id, authSessionHash: `auth-${id}` });
async function prepared() {
  const f = fixture();
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  return { f, port, cleanup: async () => { await port.close(); f.cleanup(); } };
}
test('native resource projections preserve existing DTOs and latest-result semantics without private fields', async () => {
  const p = await prepared();
  try {
    p.f.mutate(`UPDATE sessions SET status='idle',codex_thread_id='private-thread',engine_session_id='private-external' WHERE id='session';
      UPDATE users SET password_hash='private-password',display_name='Owner' WHERE id='owner';
      INSERT INTO messages(id,session_id,turn_id,role,content,phase,created_at,stopped) VALUES('interaction','session','turn','assistant','','final_answer',3,0)`);
    const project = await p.port.readProject({ principal: principal(), projectId: 'project' });
    assert.equal(project?.access_role, 'owner'); assert.equal(project?.owner?.displayName, 'Owner');
    const session = await p.port.readSession({ principal: principal(), sessionId: 'session' });
    assert.equal(session?.last_result?.messageId, 'm2'); assert.equal(session?.status, 'completed'); assert.equal(session?.can_fork, true);
    const serialized = JSON.stringify({ project, session });
    for (const secret of ['private-password', 'private-thread', 'private-external', 'auth-owner', 'owner_user_id', 'engine_metadata']) assert.equal(serialized.includes(secret), false);
    p.f.mutate("UPDATE sessions SET engine_bound=0 WHERE id='session'");
    assert.equal((await p.port.readSession({ principal: principal(), sessionId: 'session' }))?.engine, null);
  } finally { await p.cleanup(); }
});
test('project, session and message reads enforce the same current shared visibility and parent validity', async () => {
  const p = await prepared();
  const messages = () => p.port.readMessages({ principal: principal('other'), sessionId: 'session', limit: 1, before: null });
  try {
    assert.equal(await p.port.readProject({ principal: principal('other'), projectId: 'project' }), null);
    assert.equal(await p.port.readSession({ principal: principal('other'), sessionId: 'session' }), null);
    await assert.rejects(messages(), { code: 'FORBIDDEN' });
    p.f.mutate("INSERT INTO project_members VALUES('project','other','viewer',0,1,1)");
    assert.equal((await p.port.readProject({ principal: principal('other'), projectId: 'project' }))?.access_role, 'viewer');
    await assert.rejects(messages(), { code: 'FORBIDDEN' });
    p.f.mutate("UPDATE project_members SET can_view_sessions=1 WHERE user_id='other'");
    assert.equal((await messages()).messages[0].id, 'm2');
    assert.equal((await p.port.readSession({ principal: principal('other'), sessionId: 'session' }))?.id, 'session');
    p.f.mutate("DELETE FROM project_members WHERE user_id='other'");
    await assert.rejects(messages(), { code: 'FORBIDDEN' });
    p.f.mutate("UPDATE projects SET deleted_at=1 WHERE id='project'");
    for (const id of ['owner', 'admin']) {
      assert.equal(await p.port.readSession({ principal: principal(id), sessionId: 'session' }), null);
      await assert.rejects(p.port.readMessages({ principal: principal(id), sessionId: 'session', limit: 1, before: null }), { code: 'FORBIDDEN' });
    }
  } finally { await p.cleanup(); }
});
test('mine/all listings use current ownership and membership; role downgrade cannot reuse an all scope', async () => {
  const p = await prepared();
  try {
    p.f.mutate("INSERT INTO projects(id,owner_user_id,path) VALUES('admin-own','admin','D:/admin'),('other-own','other','D:/other'); INSERT INTO project_members VALUES('project','other','collaborator',1,1,1)");
    assert.deepEqual((await p.port.listProjects({ principal: principal('other'), scope: 'mine' })).map((x) => x.id), ['other-own', 'project']);
    assert.deepEqual((await p.port.listProjects({ principal: principal('admin'), scope: 'mine' })).map((x) => x.id), ['admin-own']);
    assert.equal((await p.port.listProjects({ principal: principal('admin'), scope: 'all' })).length, 3);
    await assert.rejects(p.port.listProjects({ principal: principal('other'), scope: 'all' }), { code: 'FORBIDDEN' });
    const req = { principal: principal('admin'), scope: 'all' as const, projectId: null, limit: 50, before: null };
    assert.equal((await p.port.listSessions(req)).sessions.length, 1);
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    await assert.rejects(p.port.listSessions(req), { code: 'FORBIDDEN' });
  } finally { await p.cleanup(); }
});
test('session keyset pagination is bounded and deterministic for equal timestamps and omits archived/deleted parents', async () => {
  const p = await prepared();
  try {
    p.f.mutate(`UPDATE sessions SET updated_at=10 WHERE id='session';
      INSERT INTO sessions(id,owner_user_id,project_id,updated_at) VALUES('z','owner','project',10),('a','owner','project',10);
      INSERT INTO sessions(id,owner_user_id,project_id,updated_at,archived) VALUES('archived','owner','project',11,1)`);
    const req = { principal: principal(), scope: 'mine' as const, projectId: 'project', limit: 2, before: null };
    const first = await p.port.listSessions(req); assert.deepEqual(first.sessions.map((s) => s.id), ['z', 'session']);
    assert.deepEqual(first.nextCursor, { updatedAt: 10, id: 'session' });
    const second = await p.port.listSessions({ ...req, before: first.nextCursor }); assert.deepEqual(second.sessions.map((s) => s.id), ['a']); assert.equal(second.nextCursor, null);
    p.f.mutate("UPDATE projects SET owner_user_id=NULL WHERE id='project'");
    assert.deepEqual((await p.port.listSessions(req)).sessions, []);
  } finally { await p.cleanup(); }
});
test('resource queries recheck login and password gates, reject malformed inputs and distinguish outage from missing data', async () => {
  const p = await prepared();
  try {
    const req = { principal: principal(), scope: 'mine' as const, projectId: null, limit: 1, before: null };
    for (const bad of [{ ...req, limit: 101 }, { ...req, before: { updatedAt: -1, id: 'x' } }, { ...req, before: { updatedAt: 1, id: 'x', hidden: true } }, { ...req, extra: 1 }])
      await assert.rejects(p.port.listSessions(bad as any), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(p.port.readMessages({ principal: principal(), sessionId: 'session', limit: 1, before: null, extra: true } as any), { code: 'INVALID_ARGUMENT' });
    p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'");
    await assert.rejects(p.port.readProject({ principal: principal(), projectId: 'project' }), { code: 'FORBIDDEN' });
    p.f.mutate("UPDATE users SET must_change_password=0 WHERE id='owner'; DELETE FROM auth_sessions WHERE token_hash='auth-owner'");
    await assert.rejects(p.port.listSessions(req), { code: 'FORBIDDEN' });
    await p.port.close(); await assert.rejects(p.port.readSession({ principal: principal('admin'), sessionId: 'session' }));
  } finally { await p.cleanup(); }
});
test('resource projections fail explicitly on oversized results and corrupt schema instead of trimming or returning an empty list', async () => {
  const p = await prepared();
  try {
    p.f.mutate("UPDATE projects SET name=replace(hex(zeroblob(3700000)),'0','a') WHERE id='project'");
    await assert.rejects(p.port.readProject({ principal: principal(), projectId: 'project' }), { code: 'PAYLOAD_TOO_LARGE' });
    p.f.mutate("UPDATE projects SET name='test' WHERE id='project'; UPDATE sessions SET status='invalid' WHERE id='session'");
    await assert.rejects(p.port.readSession({ principal: principal(), sessionId: 'session' }), { code: 'STORAGE_UNAVAILABLE' });
    p.f.mutate(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500)
      INSERT INTO projects(id,owner_user_id,path) SELECT 'bulk-'||x,'owner','D:/bulk/'||x FROM n`);
    await assert.rejects(p.port.listProjects({ principal: principal(), scope: 'mine' }), { code: 'PAYLOAD_TOO_LARGE' });
  } finally { await p.cleanup(); }
});
