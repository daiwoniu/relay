import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeStore } from './native-store.js';
import { fixture } from './storage-fixture.test-support.js';

test('project session count ignores pagination and follows current per-session visibility', () => {
  const f = fixture();
  f.mutate(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<60)
    INSERT INTO sessions(id,owner_user_id,project_id) SELECT 'bulk-'||x,'owner','project' FROM n;
    INSERT INTO sessions(id,owner_user_id,project_id,deleted_at,archived) VALUES
      ('other1','other','project',NULL,0),('other2','other','project',NULL,0),('other3','other','project',NULL,0),
      ('deleted','owner','project',1,0),('hidden','owner','project',NULL,1),('orphan',NULL,'project',NULL,0);
    INSERT INTO projects(id,owner_user_id,path) VALUES('empty','owner','D:/empty');
    INSERT INTO project_members VALUES('project','other','collaborator',0,1,1);`);
  const store = new NativeStore(f.filename, 'store', 1, true);
  const principal = (userId: string) => ({ kind: 'user' as const, userId, authSessionHash: `auth-${userId}` });
  const count = (userId: string) => store.readProject({ principal: principal(userId), projectId: 'project' })?.session_count;
  try {
    assert.equal(store.listSessions({ principal: principal('owner'), scope: 'mine', projectId: 'project', limit: 1, before: null }).sessions.length, 1);
    assert.equal(count('owner'), 64);
    assert.equal(count('admin'), 64);
    assert.equal(count('other'), 3);
    assert.equal(store.readProject({ principal: principal('owner'), projectId: 'empty' })?.session_count, 0);
    f.mutate("UPDATE project_members SET can_view_sessions=1 WHERE user_id='other'");
    assert.equal(count('other'), 64);
    f.mutate("UPDATE sessions SET deleted_at=1 WHERE id='bulk-1'");
    assert.equal(count('other'), 63);
    f.mutate("UPDATE project_members SET can_view_sessions=0 WHERE user_id='other'");
    assert.equal(count('other'), 3);
    f.mutate("DELETE FROM project_members WHERE user_id='other'");
    assert.equal(store.readProject({ principal: principal('other'), projectId: 'project' }), null);
  } finally { store.close(); f.cleanup(); }
});
