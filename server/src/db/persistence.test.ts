import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { claimNextQueuedEntryInDatabase, ensureEngineConcurrencyTables, insertQueuedTurnInDatabase } from './engine-concurrency.js';
import { ensureTrashCleanupJobsTable } from './trash-cleanup-jobs.js';
import { createApprovalTrustRepository, ensureApprovalTrustSettingsTable } from './approval-trust.js';
import { deleteExpiredAuthSessionsInDatabase } from './queries-account.js';
import {
  repairSessionProjectAssignmentsInDatabase,
  incrementSessionContextCompactionCountInDatabase,
  setSessionActiveTurnUsageInDatabase,
  setSessionTokenUsageInDatabase,
  syncCodexArchivedStatusesInDatabase,
} from './queries.js';

async function createTestDatabase(dbPath: string) {
  const SQL = await initSqlJs({
    locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);
  return { SQL, raw, db: new SQLiteDB(raw, dbPath) };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('启动清理登录会话仅在实际删除时保存数据库', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-auth-cleanup-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const { SQL, raw, db } = await createTestDatabase(dbPath);
  try {
    db.exec('CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    db.run("INSERT INTO auth_sessions VALUES ('expired', 10)");
    db.saveToFile();
    const originalSave = db.saveToFile.bind(db);
    let saves = 0;
    db.saveToFile = () => { saves += 1; originalSave(); };

    deleteExpiredAuthSessionsInDatabase(db, 9);
    assert.equal(saves, 0);
    deleteExpiredAuthSessionsInDatabase(db, 10);
    assert.equal(saves, 1);
    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    assert.equal(persisted.exec('SELECT COUNT(*) FROM auth_sessions')[0]?.values[0]?.[0], 0);
    persisted.close();
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('授权信任表与设置保存后可从旧库快照幂等恢复', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-approval-trust-'));
  const dbPath = path.join(tempDir, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, created_at INTEGER);
      INSERT INTO users VALUES ('user-1', 'admin', 1);
      CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), deleted_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE);
      INSERT INTO projects VALUES ('project-1', NULL);
      INSERT INTO sessions VALUES ('session-1', 'project-1', NULL);
      INSERT INTO sessions VALUES ('empty-session', 'project-1', NULL);
      INSERT INTO messages VALUES ('message-1', 'session-1');
    `);
    const db = new SQLiteDB(raw, dbPath);
    assert.equal(ensureApprovalTrustSettingsTable(db), true);
    assert.equal(ensureApprovalTrustSettingsTable(db), false);
    createApprovalTrustRepository(db).upsertSessionTrustSetting({
      ownerUserId: 'user-1', sessionId: 'session-1', mode: 'manual', expiresAt: null, now: 100,
    });
    createApprovalTrustRepository(db).upsertSessionTrustSetting({
      ownerUserId: 'user-1', sessionId: 'empty-session', mode: 'trusted', expiresAt: null, now: 101,
    });

    const restoredRaw = new SQL.Database(fs.readFileSync(dbPath));
    const restored = new SQLiteDB(restoredRaw, dbPath);
    assert.equal(ensureApprovalTrustSettingsTable(restored), false);
    assert.equal(createApprovalTrustRepository(restored, { save: () => {} })
      .getSessionTrustSetting('user-1', 'session-1')?.mode, 'manual');
    assert.equal(createApprovalTrustRepository(restored, { save: () => {} })
      .getSessionTrustSetting('user-1', 'empty-session'), null);
    restoredRaw.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('附件清理任务表可重复迁移并随数据库快照持久化', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-trash-cleanup-'));
  const dbPath = path.join(tempDir, 'relay.db');
  try {
    const { SQL, raw, db } = await createTestDatabase(dbPath);
    ensureTrashCleanupJobsTable(db);
    ensureTrashCleanupJobsTable(db);
    db.run(
      `INSERT INTO trash_attachment_cleanup_jobs (
         operation_id, quarantine_path, status, attempt_count, created_at, updated_at
       ) VALUES (?, ?, 'pending', 0, ?, ?)`,
      ['operation-1', 'D:/project/.relay_upload/.trash-quarantine/operation-1', 100, 100],
    );
    db.saveToFile();

    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    const result = persisted.exec(
      'SELECT operation_id, quarantine_path, status, attempt_count FROM trash_attachment_cleanup_jobs',
    )[0]?.values[0];
    assert.deepEqual(result, [
      'operation-1',
      'D:/project/.relay_upload/.trash-quarantine/operation-1',
      'pending',
      0,
    ]);
    persisted.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('并发队列与租约表保存后可从磁盘恢复', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-engine-concurrency-'));
  const dbPath = path.join(tempDir, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, engine TEXT NOT NULL, status TEXT NOT NULL,
        active_attempt_id TEXT, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL
      );
      INSERT INTO users VALUES ('user-1');
      INSERT INTO sessions VALUES ('session-1', 'codex', 'idle', NULL, 1, NULL);
      INSERT INTO messages VALUES ('message-1', 'session-1', 'hello');
    `);
    const db = new SQLiteDB(raw, dbPath);
    assert.equal(ensureEngineConcurrencyTables(db), true);
    insertQueuedTurnInDatabase(db, {
      id: 'queue-1', sessionId: 'session-1', attemptId: 'attempt-1', userMessageId: 'message-1',
      engineId: 'codex', resourceKey: 'codex:default', requestedByUserId: 'user-1', createdAt: 10,
    });
    assert.equal(claimNextQueuedEntryInDatabase(db, {
      resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: 'claim-1', now: 20,
    })?.queue.attemptId, 'attempt-1');
    db.saveToFile();

    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    assert.equal(persisted.exec('SELECT attempt_id FROM engine_queue_entries')[0]?.values[0]?.[0], 'attempt-1');
    assert.equal(persisted.exec("SELECT last_served_user_id FROM engine_queue_fairness WHERE resource_key = 'codex:default'")[0]?.values[0]?.[0], 'user-1');
    assert.equal(persisted.exec("SELECT status FROM sessions WHERE id = 'session-1'")[0]?.values[0]?.[0], 'pending');
    persisted.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('同一窗口内多次调度只保存一次数据库快照', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-scheduled-save-'));
  const dbPath = path.join(tempDir, 'relay.db');

  try {
    const { SQL, raw, db } = await createTestDatabase(dbPath);
    const saveImmediately = db.saveToFile.bind(db);
    let saveCount = 0;
    db.saveToFile = () => {
      saveCount += 1;
      saveImmediately();
    };

    db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['active', '第一次更新']);
    db.run('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)', ['message-1', 'active', 'hello']);
    db.scheduleSaveToFile(20);
    db.run('UPDATE sessions SET title = ? WHERE id = ?', ['最后一次更新', 'active']);
    db.scheduleSaveToFile(20);

    await wait(60);

    assert.equal(saveCount, 1);
    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    assert.equal(persisted.exec("SELECT title FROM sessions WHERE id = 'active'")[0]?.values[0]?.[0], '最后一次更新');
    persisted.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('立即保存会取消已经调度的重复快照', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-immediate-save-'));
  const dbPath = path.join(tempDir, 'relay.db');

  try {
    const { raw, db } = await createTestDatabase(dbPath);
    const saveImmediately = db.saveToFile.bind(db);
    let saveCount = 0;
    db.saveToFile = () => {
      saveCount += 1;
      saveImmediately();
    };

    db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['active', '已发送']);
    db.run('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)', ['message-1', 'active', 'hello']);
    db.scheduleSaveToFile(30);
    db.saveToFile();

    await wait(70);

    assert.equal(saveCount, 1);
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('flush 只在存在待保存快照时立即写盘', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-flush-save-'));
  const dbPath = path.join(tempDir, 'relay.db');

  try {
    const { raw, db } = await createTestDatabase(dbPath);
    const saveImmediately = db.saveToFile.bind(db);
    let saveCount = 0;
    db.saveToFile = () => {
      saveCount += 1;
      saveImmediately();
    };

    db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['active', '已发送']);
    db.run('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)', ['message-1', 'active', 'hello']);
    db.scheduleSaveToFile(100);

    assert.equal(db.flushPendingSave(), true);
    assert.equal(db.flushPendingSave(), false);
    assert.equal(saveCount, 1);
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('严格保存遇到 Windows 文件占用时抛错，默认保存仍保持兼容', async (t) => {
  const { raw, db } = await createTestDatabase(path.join(os.tmpdir(), 'relay-db-locked.db'));
  try {
    const locked = Object.assign(new Error('locked'), { code: 'EPERM' });
    t.mock.method(fs, 'writeFileSync', () => { throw locked; });
    assert.doesNotThrow(() => db.saveToFile());
    assert.throws(() => db.saveToFile({ failOnLocked: true }), /locked/);
  } finally {
    raw.close();
  }
});

test('保存快照排除空会话，但保留内存中的空会话', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-persistence-'));
  const dbPath = path.join(tempDir, 'relay.db');

  try {
    const { SQL, raw, db } = await createTestDatabase(dbPath);
    db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['empty', '空会话']);
    db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['active', '已发送']);
    db.run('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)', ['message-1', 'active', 'hello']);

    db.saveToFile();

    assert.equal(db.get('SELECT id FROM sessions WHERE id = ?', ['empty'])?.id, 'empty');
    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    assert.deepEqual(persisted.exec('SELECT id FROM sessions ORDER BY id')[0]?.values, [['active']]);
    persisted.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('没有待排除的空草稿时直接导出当前数据库，不构造快照副本', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-fast-save-'));
  const dbPath = path.join(tempDir, 'relay.db');

  try {
    const { SQL, raw, db } = await createTestDatabase(dbPath);
    db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['active', '已发送']);
    db.run('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)', ['message-1', 'active', 'hello']);

    const DatabaseCtor = raw.constructor as unknown as new (data?: ArrayLike<number>) => typeof raw;
    let snapshotConstructionCount = 0;
    Object.defineProperty(raw, 'constructor', {
      configurable: true,
      value: function CountingDatabase(data?: ArrayLike<number>) {
        snapshotConstructionCount += 1;
        return new DatabaseCtor(data);
      },
    });

    db.saveToFile();

    assert.equal(snapshotConstructionCount, 0);
    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    assert.equal(persisted.exec("SELECT content FROM messages WHERE id = 'message-1'")[0]?.values[0]?.[0], 'hello');
    persisted.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('删除会话及其消息后再次保存会从磁盘移除', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-delete-'));
  const dbPath = path.join(tempDir, 'relay.db');

  try {
    const { SQL, raw, db } = await createTestDatabase(dbPath);
    db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['active', '已发送']);
    db.run('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)', ['message-1', 'active', 'hello']);
    db.saveToFile();

    db.run('DELETE FROM messages WHERE session_id = ?', ['active']);
    db.run('DELETE FROM sessions WHERE id = ?', ['active']);
    db.saveToFile();

    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    assert.equal(persisted.exec('SELECT id FROM sessions').length, 0);
    assert.equal(persisted.exec('SELECT id FROM messages').length, 0);
    persisted.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('批量同步 Codex 归档状态只修改关联 thread', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-archive-'));
  const dbPath = path.join(tempDir, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        archived INTEGER DEFAULT 0,
        codex_thread_id TEXT,
        codex_archived INTEGER DEFAULT 0,
        codex_archived_for_trash INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'assistant', phase TEXT, turn_id TEXT,
        metadata TEXT, stopped INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sessions (id, codex_thread_id, codex_archived, codex_archived_for_trash) VALUES
        ('session-active', 'thread-active', 1, 0),
        ('session-archived', 'thread-archived', 0, 0),
        ('session-local-archived', 'thread-hidden', 0, 0),
        ('session-stale-marker', 'thread-restored', 0, 1);
      UPDATE sessions SET archived = 1 WHERE id = 'session-local-archived';
    `);
    const db = new SQLiteDB(raw, dbPath);
    const changed = syncCodexArchivedStatusesInDatabase(db, ['thread-archived']);

    assert.deepEqual(changed.map((session) => session.id).sort(), ['session-active', 'session-archived', 'session-stale-marker']);
    assert.equal(db.get('SELECT codex_archived FROM sessions WHERE id = ?', ['session-active'])?.codex_archived, 0);
    assert.equal(db.get('SELECT codex_archived FROM sessions WHERE id = ?', ['session-archived'])?.codex_archived, 1);
    assert.equal(db.get('SELECT codex_archived FROM sessions WHERE id = ?', ['session-local-archived'])?.codex_archived, 0);
    assert.equal(db.get('SELECT codex_archived_for_trash FROM sessions WHERE id = ?', ['session-stale-marker'])?.codex_archived_for_trash, 0);
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('软删除的空会话保存快照时不会被空会话清理物理移除', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-soft-delete-empty-'));
  const dbPath = path.join(tempDir, 'relay.db');

  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, deleted_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL);
      CREATE TABLE shared_records (id TEXT PRIMARY KEY, source_session_id TEXT);
      INSERT INTO sessions (id, title, deleted_at) VALUES ('deleted-empty', '已删除空会话', 100);
      INSERT INTO shared_records (id, source_session_id) VALUES ('share-1', 'deleted-empty');
    `);
    const db = new SQLiteDB(raw, dbPath);
    db.saveToFile();

    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    assert.equal(persisted.exec("SELECT id FROM sessions WHERE id = 'deleted-empty'")[0]?.values[0]?.[0], 'deleted-empty');
    assert.equal(persisted.exec("SELECT source_session_id FROM shared_records WHERE id = 'share-1'")[0]?.values[0]?.[0], 'deleted-empty');
    persisted.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('会话上下文用量快照会持久化到磁盘', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-token-usage-'));
  const dbPath = path.join(tempDir, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, token_usage TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      INSERT INTO sessions (id, token_usage) VALUES ('session-1', NULL);
      INSERT INTO messages (id, session_id) VALUES ('message-1', 'session-1');
    `);
    const db = new SQLiteDB(raw, dbPath);
    const usage = { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 160, reasoningOutputTokens: 40, totalTokens: 1360, modelContextWindow: 200000 };

    setSessionTokenUsageInDatabase(db, 'session-1', usage);

    assert.equal(fs.existsSync(dbPath), false);
    assert.equal(db.flushPendingSave(), true);

    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    const stored = persisted.exec("SELECT token_usage FROM sessions WHERE id = 'session-1'")[0]?.values[0]?.[0];
    assert.deepEqual(JSON.parse(String(stored)), usage);
    persisted.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('同一上下文自动整理事件原子递增一次并立即持久化', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-context-compaction-'));
  const dbPath = path.join(tempDir, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, context_compaction_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE context_compaction_events (
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, thread_id, turn_id)
      );
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      INSERT INTO sessions (id) VALUES ('session-1');
      INSERT INTO messages (id, session_id) VALUES ('message-1', 'session-1');
    `);
    const db = new SQLiteDB(raw, dbPath);

    assert.deepEqual(incrementSessionContextCompactionCountInDatabase(db, 'session-1', { threadId: 'thread-1', turnId: 'turn-1' }), { count: 1, incremented: true });
    assert.deepEqual(incrementSessionContextCompactionCountInDatabase(db, 'session-1', { threadId: 'thread-1', turnId: 'turn-1' }), { count: 1, incremented: false });
    assert.deepEqual(incrementSessionContextCompactionCountInDatabase(db, 'session-1', { threadId: 'thread-1', turnId: 'turn-2' }), { count: 2, incremented: true });

    const persisted = new SQL.Database(fs.readFileSync(dbPath));
    assert.equal(persisted.exec("SELECT context_compaction_count FROM sessions WHERE id = 'session-1'")[0]?.values[0]?.[0], 2);
    persisted.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('活动回合用量非空时合并保存，清空时立即保存', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-active-turn-usage-'));
  const dbPath = path.join(tempDir, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, active_turn_usage TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      INSERT INTO sessions (id, active_turn_usage) VALUES ('session-1', NULL);
      INSERT INTO messages (id, session_id) VALUES ('message-1', 'session-1');
    `);
    const db = new SQLiteDB(raw, dbPath);
    const usage = { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 160, reasoningOutputTokens: 40, totalTokens: 1360, modelContextWindow: 200000 };

    setSessionActiveTurnUsageInDatabase(db, 'session-1', usage);

    assert.equal(fs.existsSync(dbPath), false);
    assert.equal(db.flushPendingSave(), true);
    const persistedUsage = new SQL.Database(fs.readFileSync(dbPath));
    assert.deepEqual(
      JSON.parse(String(persistedUsage.exec("SELECT active_turn_usage FROM sessions WHERE id = 'session-1'")[0]?.values[0]?.[0])),
      usage,
    );
    persistedUsage.close();

    setSessionActiveTurnUsageInDatabase(db, 'session-1', { ...usage, totalTokens: 1500 });
    setSessionActiveTurnUsageInDatabase(db, 'session-1', null);

    const persistedCleared = new SQL.Database(fs.readFileSync(dbPath));
    assert.equal(persistedCleared.exec("SELECT active_turn_usage FROM sessions WHERE id = 'session-1'")[0]?.values[0]?.[0], null);
    persistedCleared.close();
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('修复无项目和失效项目会话到默认项目', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-db-project-repair-'));
  const dbPath = path.join(tempDir, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL);
      INSERT INTO projects (id) VALUES ('default-project'), ('valid-project');
      INSERT INTO sessions (id, project_id, updated_at) VALUES
        ('missing-project', NULL, 1),
        ('orphan-project', 'deleted-project', 1),
        ('valid-session', 'valid-project', 1);
    `);
    const db = new SQLiteDB(raw, dbPath);

    const repaired = repairSessionProjectAssignmentsInDatabase(db, 'default-project', 123);

    assert.equal(repaired, 2);
    assert.equal(db.get('SELECT project_id FROM sessions WHERE id = ?', ['missing-project'])?.project_id, 'default-project');
    assert.equal(db.get('SELECT project_id FROM sessions WHERE id = ?', ['orphan-project'])?.project_id, 'default-project');
    assert.equal(db.get('SELECT project_id FROM sessions WHERE id = ?', ['valid-session'])?.project_id, 'valid-project');
    assert.equal(db.get('SELECT updated_at FROM sessions WHERE id = ?', ['valid-session'])?.updated_at, 1);
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
