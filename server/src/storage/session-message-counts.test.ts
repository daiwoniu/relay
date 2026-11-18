import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createForkedSessionInDatabase, type Session } from '../db/queries.js';
import { nativeQueries } from './native-queries.js';
import { NativeStore } from './native-store.js';
import { fixture } from './storage-fixture.test-support.js';

test('session list/details count persisted messages by role, regardless of revision, items or message pagination', () => {
  const f = fixture();
  f.mutate(`DELETE FROM messages;
    UPDATE sessions SET message_revision=99;
    INSERT INTO messages VALUES
      ('u1','session','turn','user','first',NULL,NULL,NULL,1,NULL,0),
      ('u2','session','turn','user','followup',NULL,NULL,NULL,2,NULL,0),
      ('a1','session','turn','assistant','reply','final_answer','[{"id":"tool1"},{"id":"tool2"}]',NULL,3,NULL,0);
    INSERT INTO sessions(id,owner_user_id,project_id,message_revision,engine,engine_bound,status,archived,created_at,updated_at,title,pinned)
      VALUES('empty','owner','project',7,'codex',1,'idle',0,1,1,'empty',0);`);
  const store = new NativeStore(f.filename, 'store', 1, true);
  const principal = { kind: 'user' as const, userId: 'owner', authSessionHash: 'auth-owner' };
  const read = () => store.readSessionDetails({ principal, sessionId: 'session' });
  try {
    assert.equal(read()?.message_count, 3);
    assert.equal(read()?.assistant_message_count, 1);
    const list = store.listSessions({ principal, scope: 'mine', projectId: null, limit: 50, before: null });
    assert.equal(list.sessions.find(s => s.id === 'session')?.message_count, 3);
    assert.equal(list.sessions.find(s => s.id === 'session')?.assistant_message_count, 1);
    assert.equal(list.sessions.find(s => s.id === 'empty')?.message_count, 0);
    assert.equal(list.sessions.find(s => s.id === 'empty')?.assistant_message_count, 0);
    const page = store.readMessages({ principal, sessionId: 'session', limit: 1, before: null });
    assert.equal(page.messages.length, 1);
    assert.equal(read()?.message_count, 3);
    f.mutate("UPDATE messages SET content='updated' WHERE id='a1'; UPDATE sessions SET message_revision=100");
    assert.equal(read()?.message_count, 3);
    assert.equal(read()?.assistant_message_count, 1);
    f.mutate("INSERT INTO messages VALUES('a2','session','next','assistant','next reply','final_answer',NULL,NULL,4,NULL,0)");
    assert.equal(read()?.message_count, 4);
    assert.equal(read()?.assistant_message_count, 2);
    assert.equal(store.readSession({ principal: { kind: 'user', userId: 'other', authSessionHash: 'auth-other' }, sessionId: 'session' }), null);
  } finally { store.close(); f.cleanup(); }
});

test('compatibility fork returns the copied message counts immediately', () => {
  const f = fixture();
  const connection = new DatabaseSync(f.filename);
  const db = nativeQueries(connection);
  try {
    connection.exec('BEGIN IMMEDIATE');
    const source = db.get("SELECT * FROM sessions WHERE id='session'") as Session;
    const fork = createForkedSessionInDatabase(db, {
      id: 'fork', title: 'fork', source, threadId: 'fork-thread', now: 100,
      messages: ['user', 'user', 'assistant'].map((role, i) => ({
        id: `fork-message-${i}`, session_id: 'fork', turn_id: 'turn', role: role as 'user' | 'assistant',
        content: 'copied', phase: null, items: null, metadata: null,
      })),
    });
    assert.equal(fork.message_count, 3);
    assert.equal(fork.assistant_message_count, 1);
    connection.exec('COMMIT');
  } finally {
    if (connection.isTransaction) connection.exec('ROLLBACK');
    connection.close(); f.cleanup();
  }
});
