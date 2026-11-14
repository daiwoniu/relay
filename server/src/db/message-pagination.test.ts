import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { getMessagesInDatabase, saveMessagesInDatabase } from './queries.js';

test('消息分页从最新一页开始并保持页面内时间升序', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-page-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);

  try {
    raw.exec(`
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
    for (let index = 1; index <= 70; index += 1) {
      const id = `message-${String(index).padStart(3, '0')}`;
      db.run(
        'INSERT INTO messages (id, session_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, 'session-1', 'turn-1', 'assistant', id, index],
      );
    }

    assert.deepEqual(
      getMessagesInDatabase(db, 'session-1', 30, 0).map((message) => message.id),
      Array.from({ length: 30 }, (_, index) => `message-${String(index + 41).padStart(3, '0')}`),
    );
    assert.deepEqual(
      getMessagesInDatabase(db, 'session-1', 30, 30).map((message) => message.id),
      Array.from({ length: 30 }, (_, index) => `message-${String(index + 11).padStart(3, '0')}`),
    );
    assert.deepEqual(
      getMessagesInDatabase(db, 'session-1', 30, 60).map((message) => message.id),
      Array.from({ length: 10 }, (_, index) => `message-${String(index + 1).padStart(3, '0')}`),
    );
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('批量保存消息在单事务中连续推进 revision', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-batch-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);

  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, message_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, phase TEXT, items TEXT, metadata TEXT, created_at INTEGER NOT NULL,
        duration INTEGER, stopped INTEGER DEFAULT 0
      );
      INSERT INTO sessions (id, updated_at, message_revision) VALUES ('session-1', 0, 3);
    `);

    const saved = saveMessagesInDatabase(db, [
      { id: 'user-1', session_id: 'session-1', turn_id: 'turn-1', role: 'user', content: '你好', phase: null, items: null, metadata: null },
      { id: 'error-1', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant', content: '', phase: 'error', items: null, metadata: null },
    ], 100);

    assert.deepEqual(saved.map((record) => record.revision), [4, 5]);
    assert.deepEqual(getMessagesInDatabase(db, 'session-1', 10, 0).map((message) => message.id), ['user-1', 'error-1']);
    assert.equal(db.get('SELECT message_revision FROM sessions WHERE id = ?', ['session-1'])?.message_revision, 5);
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assistant 消息统一以精简过程项写入数据库', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-items-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);

  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, message_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, phase TEXT, items TEXT, metadata TEXT, created_at INTEGER NOT NULL,
        duration INTEGER, stopped INTEGER DEFAULT 0
      );
      INSERT INTO sessions (id, updated_at, message_revision) VALUES ('session-1', 0, 0);
    `);
    const originalItems = JSON.stringify([{
      id: 'command-1', type: 'commandExecution', status: 'completed', command: 'npm test',
      aggregatedOutput: Array.from({ length: 100 }, (_, index) => `输出 ${index}`).join('\n'),
    }]);
    saveMessagesInDatabase(db, [{
      id: 'assistant-1', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant',
      content: '完成', phase: 'final_answer', items: originalItems, metadata: null,
    }], 100);

    const stored = getMessagesInDatabase(db, 'session-1', 10, 0)[0]?.items;
    assert.ok(stored);
    const [item] = JSON.parse(stored!);
    assert.equal(item.details.aggregatedOutput, undefined);
    assert.equal(item.details.outputSummary.lineCount, 100);
    assert.ok(Buffer.byteLength(stored!) < Buffer.byteLength(originalItems));
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('批量保存基于会话现有时间严格递增且不会回退 updated_at', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-batch-time-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);

  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, message_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, phase TEXT, items TEXT, metadata TEXT, created_at INTEGER NOT NULL,
        duration INTEGER, stopped INTEGER DEFAULT 0
      );
      INSERT INTO sessions (id, updated_at, message_revision) VALUES ('session-1', 200, 0);
    `);

    const pair = saveMessagesInDatabase(db, [
      { id: 'user-1', session_id: 'session-1', turn_id: 'turn-1', role: 'user', content: '你好', phase: null, items: null, metadata: null },
      { id: 'error-1', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant', content: '', phase: 'error', items: null, metadata: null },
    ], 100);
    const next = saveMessagesInDatabase(db, [
      { id: 'user-2', session_id: 'session-1', turn_id: 'turn-2', role: 'user', content: '继续', phase: null, items: null, metadata: null },
    ], 100);

    assert.deepEqual(pair.map((record) => record.message.created_at), [201, 202]);
    assert.equal(next[0]?.message.created_at, 203);
    assert.equal(db.get('SELECT updated_at FROM sessions WHERE id = ?', ['session-1'])?.updated_at, 203);
    assert.deepEqual(getMessagesInDatabase(db, 'session-1', 10, 0).map((message) => message.id), ['user-1', 'error-1', 'user-2']);
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('批量保存任一消息失败时整体回滚', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-batch-rollback-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);

  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, message_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, phase TEXT, items TEXT, metadata TEXT, created_at INTEGER NOT NULL,
        duration INTEGER, stopped INTEGER DEFAULT 0
      );
      INSERT INTO sessions (id, updated_at, message_revision) VALUES ('session-1', 0, 0);
    `);

    assert.throws(() => saveMessagesInDatabase(db, [
      { id: 'duplicate', session_id: 'session-1', turn_id: 'turn-1', role: 'user', content: '你好', phase: null, items: null, metadata: null },
      { id: 'duplicate', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant', content: '', phase: 'error', items: null, metadata: null },
    ], 100));

    assert.deepEqual(getMessagesInDatabase(db, 'session-1', 10, 0), []);
    assert.equal(db.get('SELECT message_revision FROM sessions WHERE id = ?', ['session-1'])?.message_revision, 0);
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
