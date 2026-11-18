import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NativeStore } from './native-store.js';
import { fixture } from './storage-fixture.test-support.js';
import type { CoreCommand } from './contracts.js';

const principal = (userId: string) => ({ kind: 'user' as const, userId, authSessionHash: `auth-${userId}` });
test('trash people preserve each creator and the committed deletion initiator, including earlier deleted children', () => {
  const f = fixture(), project = randomUUID(), early = randomUUID(), fresh = randomUUID(), historical = randomUUID();
  f.mutate(`INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','owner','D:/trash-people','Same name');
    INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,deleted_at) VALUES
    ('${early}','other','${project}','early','completed','codebuddy',NULL),
    ('${fresh}','owner','${project}','fresh','completed','codebuddy',NULL),
    ('${historical}','other','${project}','historical','completed','codebuddy',7);`);
  const store = new NativeStore(f.filename, 'store', 1, true);
  const execute = (userId: string, command: CoreCommand) => {
    const operationId = randomUUID();
    const result = store.execute({ protocolVersion: 1, storeId: 'store', workerGeneration: 1,
      requestId: operationId, operationId, principal: principal(userId), command });
    assert.equal(result.state, 'committed');
  };
  const remove = (userId: string, kind: 'project' | 'session', resourceId: string) => {
    const jobId = randomUUID();
    execute(userId, { name: 'trash.prepareSoftDelete', input: { jobId, kind, resourceId, archiveCodex: false } });
    execute(userId, { name: 'trash.commitSoftDelete', input: { jobId } });
  };
  try {
    remove('other', 'session', early);
    remove('admin', 'project', project);
    const projects = store.readTrash({ principal: principal('admin'), name: 'projects', input: { limit: 30, offset: 0, q: '' } });
    const row = projects.items.find(p => p.id === project)!;
    assert.equal(row.creator?.username, 'owner'); assert.equal(row.deletedBy?.username, 'admin');
    const children = store.readTrash({ principal: principal('admin'), name: 'projectSessions', input: { projectId: project, limit: 100, offset: 0 } }).items;
    assert.equal(children.find(s => s.id === early)?.creator?.username, 'other');
    assert.equal(children.find(s => s.id === early)?.deletedBy?.username, 'other');
    assert.equal(children.find(s => s.id === fresh)?.deletedBy?.username, 'admin');
    assert.equal(children.find(s => s.id === historical)?.creator?.username, 'other');
    assert.equal(children.find(s => s.id === historical)?.deletedBy, null);
    const match = store.readTrash({ principal: principal('admin'), name: 'projects', input: { limit: 30, offset: 0, q: 'fresh' } }).items[0]!;
    assert.equal(match.matchSessionCreator?.username, 'owner'); assert.equal(match.matchSessionDeletedBy?.username, 'admin');
    assert.equal(match.matchSessionEngine, 'codebuddy'); assert.equal(match.matchSessionEngineSessionId, null);
    assert.equal(match.matchSessionDeletedAt, children.find(s => s.id === fresh)?.deletedAt);
    assert.equal(store.readTrash({ principal: principal('other'), name: 'projects', input: { limit: 30, offset: 0, q: '' } }).items.length, 0);
    const serialized = JSON.stringify({ row, children });
    for (const field of ['authSessionHash', 'password_hash', 'source_digest', 'actor_user_id']) assert.equal(serialized.includes(field), false);
  } finally { store.close(); f.cleanup(); }
});

test('pending and stale deletion jobs cannot identify a current independent deletion', () => {
  const f = fixture(), project = randomUUID(), session = randomUUID(), job = randomUUID();
  f.mutate(`INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','owner','D:/people-active','Active');
    INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,deleted_at) VALUES('${session}','owner','${project}','legacy','completed','codebuddy',100);`);
  const store = new NativeStore(f.filename, 'store', 1, true);
  const read = () => store.readTrash({ principal: principal('owner'), name: 'sessions', input: { limit: 30, offset: 0, q: '', projectId: null } }).items[0]!;
  try {
    f.mutate(`INSERT INTO _relay_soft_delete_jobs VALUES('${job}','session','${session}','${project}','owner','admin','digest','prepared',1,100);
      INSERT INTO _relay_soft_delete_sessions VALUES('${job}','${session}',0,NULL,0);`);
    assert.equal(read().creator?.username, 'owner'); assert.equal(read().deletedBy, null);
    f.mutate(`UPDATE _relay_soft_delete_jobs SET phase='committed',updated_at=99 WHERE id='${job}'`);
    assert.equal(read().deletedBy, null);
    f.mutate(`UPDATE _relay_soft_delete_jobs SET updated_at=100 WHERE id='${job}'`);
    assert.equal(read().deletedBy?.username, 'admin');
    f.mutate(`UPDATE sessions SET deleted_at=101 WHERE id='${session}'`);
    assert.equal(read().deletedBy, null);
  } finally { store.close(); f.cleanup(); }
});
