import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import {
  createSharedRecordInDatabase,
  deleteInvalidSharedRecordInDatabase,
  detachShareSourceSessionInDatabase,
  getSharedRecordByPublicTokenInDatabase,
  listSharedRecordsByOwnerInDatabase,
  revokeSharedRecordInDatabase,
  type SharedRecord,
} from './queries.js';

async function createDatabase(dbPath: string) {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, engine TEXT NOT NULL DEFAULT 'codex');
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE shared_records (
      id TEXT PRIMARY KEY, public_token TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL,
      source_session_id TEXT, title TEXT NOT NULL, scope TEXT NOT NULL, message_count INTEGER NOT NULL,
      include_process INTEGER NOT NULL, snapshot_version INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER
    );
  `);
  return { SQL, raw, db: new SQLiteDB(raw, dbPath) };
}

function record(overrides: Partial<SharedRecord> = {}): SharedRecord {
  return {
    id: 'share-1', public_token: 'token-1', owner_user_id: 'owner-1', source_session_id: 'session-1',
    title: '分享', scope: 'session', message_count: 2, include_process: 0, snapshot_version: 1,
    snapshot_json: '{"version":1,"messages":[]}', created_at: 100, expires_at: 1000, revoked_at: null,
    ...overrides,
  };
}

test('分享快照独立持久化且删除来源会话后仍可读取', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-shares-'));
  const dbPath = path.join(tempDir, 'relay.db');
  try {
    const { SQL, raw, db } = await createDatabase(dbPath);
    db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['session-1', '来源会话']);
    db.run('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)', ['message-1', 'session-1', '内容']);
    createSharedRecordInDatabase(db, record());
    detachShareSourceSessionInDatabase(db, 'session-1');
    db.run('DELETE FROM messages WHERE session_id = ?', ['session-1']);
    db.run('DELETE FROM sessions WHERE id = ?', ['session-1']);
    db.saveToFile();

    const persistedRaw = new SQL.Database(fs.readFileSync(dbPath));
    const persisted = new SQLiteDB(persistedRaw, dbPath);
    const saved = getSharedRecordByPublicTokenInDatabase(persisted, 'token-1');
    assert.equal(saved?.source_session_id, null);
    assert.equal(saved?.snapshot_json, '{"version":1,"messages":[]}');
    persistedRaw.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('分享查询按所有者隔离并保留来源标题', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-share-owner-'));
  try {
    const { raw, db } = await createDatabase(path.join(tempDir, 'relay.db'));
    db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['session-1', '来源会话']);
    createSharedRecordInDatabase(db, record());
    createSharedRecordInDatabase(db, record({ id: 'share-2', public_token: 'token-2', owner_user_id: 'owner-2' }));
    const rows = listSharedRecordsByOwnerInDatabase(db, 'owner-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_session_title, '来源会话');
    assert.equal(rows[0].source_session_engine, 'codex');
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('分享来源会话删除后数据库列表不伪造 Codex 来源', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-share-detached-engine-'));
  try {
    const { raw, db } = await createDatabase(path.join(tempDir, 'relay.db'));
    db.run("INSERT INTO sessions (id, title, engine) VALUES (?, ?, ?)", ['session-1', 'CodeBuddy 来源', 'codebuddy']);
    createSharedRecordInDatabase(db, record({
      snapshot_json: '{"version":1,"sourceEngine":"codebuddy","messages":[]}',
    }));
    detachShareSourceSessionInDatabase(db, 'session-1');
    db.run('DELETE FROM sessions WHERE id = ?', ['session-1']);
    const rows = listSharedRecordsByOwnerInDatabase(db, 'owner-1');
    assert.equal(rows[0]?.source_session_engine, null);
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('有效分享只能先撤销，过期或撤销后才能删除', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-share-lifecycle-'));
  try {
    const { raw, db } = await createDatabase(path.join(tempDir, 'relay.db'));
    createSharedRecordInDatabase(db, record({ source_session_id: null, expires_at: 1000 }));
    assert.equal(deleteInvalidSharedRecordInDatabase(db, 'share-1', 'owner-1', 500), false);
    assert.equal(revokeSharedRecordInDatabase(db, 'share-1', 'owner-2', 500), false);
    assert.equal(revokeSharedRecordInDatabase(db, 'share-1', 'owner-1', 500), true);
    assert.equal(deleteInvalidSharedRecordInDatabase(db, 'share-1', 'owner-1', 500), true);
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
