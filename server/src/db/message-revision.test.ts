import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { ensureMessageRevisionColumn, SQLiteDB } from './index.js';
import { getMessagePageInDatabase, saveMessageInDatabase } from './queries.js';

async function createDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-revision-'));
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, path.join(directory, 'relay.db'));
  raw.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      phase TEXT,
      items TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      duration INTEGER,
      stopped INTEGER DEFAULT 0
    );
  `);
  return { directory, raw, db };
}

test('message revision 迁移按现有消息数回填且重复执行幂等', async () => {
  const current = await createDatabase();
  try {
    current.db.run('INSERT INTO sessions (id, updated_at) VALUES (?, ?)', ['session-1', 1]);
    current.db.run(
      'INSERT INTO messages (id, session_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['message-1', 'session-1', 'turn-1', 'user', '一', 1],
    );
    current.db.run(
      'INSERT INTO messages (id, session_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['message-2', 'session-1', 'turn-2', 'assistant', '二', 2],
    );

    assert.equal(ensureMessageRevisionColumn(current.db), true);
    assert.equal(current.db.get('SELECT message_revision FROM sessions WHERE id = ?', ['session-1'])?.message_revision, 2);
    assert.equal(ensureMessageRevisionColumn(current.db), false);
    assert.equal(current.db.get('SELECT message_revision FROM sessions WHERE id = ?', ['session-1'])?.message_revision, 2);
  } finally {
    current.raw.close();
    fs.rmSync(current.directory, { recursive: true, force: true });
  }
});

test('消息写入与 revision 在同一事务，失败不会单独递增', async () => {
  const current = await createDatabase();
  try {
    current.db.run('ALTER TABLE sessions ADD COLUMN message_revision INTEGER NOT NULL DEFAULT 0');
    current.db.run('INSERT INTO sessions (id, updated_at) VALUES (?, ?)', ['session-1', 1]);
    const message = {
      id: 'message-1', session_id: 'session-1', turn_id: 'turn-1', role: 'user' as const,
      content: '消息', phase: null, items: null, metadata: null, duration: null, stopped: 0,
    };
    assert.equal(saveMessageInDatabase(current.db, message, 10).revision, 1);
    assert.throws(() => saveMessageInDatabase(current.db, message, 11));
    assert.equal(current.db.get('SELECT message_revision FROM sessions WHERE id = ?', ['session-1'])?.message_revision, 1);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM messages')?.count, 1);
  } finally {
    current.raw.close();
    fs.rmSync(current.directory, { recursive: true, force: true });
  }
});

test('稳定游标在同一时间戳下按 id 分页且不重复遗漏', async () => {
  const current = await createDatabase();
  try {
    current.db.run('ALTER TABLE sessions ADD COLUMN message_revision INTEGER NOT NULL DEFAULT 0');
    current.db.run('INSERT INTO sessions (id, updated_at, message_revision) VALUES (?, ?, ?)', ['session-1', 1, 5]);
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      current.db.run(
        'INSERT INTO messages (id, session_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, 'session-1', `turn-${id}`, 'assistant', id, 100],
      );
    }
    const latest = getMessagePageInDatabase(current.db, 'session-1', 2);
    const older = getMessagePageInDatabase(current.db, 'session-1', 2, latest.nextCursor);
    const oldest = getMessagePageInDatabase(current.db, 'session-1', 2, older.nextCursor);
    assert.deepEqual(latest.messages.map((message) => message.id), ['d', 'e']);
    assert.deepEqual(older.messages.map((message) => message.id), ['b', 'c']);
    assert.deepEqual(oldest.messages.map((message) => message.id), ['a']);
    assert.equal(new Set([...latest.messages, ...older.messages, ...oldest.messages].map((message) => message.id)).size, 5);
  } finally {
    current.raw.close();
    fs.rmSync(current.directory, { recursive: true, force: true });
  }
});
