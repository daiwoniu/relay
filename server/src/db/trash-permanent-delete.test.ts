import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { ensureTrashCleanupJobsTable } from './trash-cleanup-jobs.js';
import { ensureWorkspaceConsoleLinksTable } from './workspace-console-links-migration.js';
import {
  permanentlyDeleteProjectInDatabase,
  permanentlyDeleteSessionInDatabase,
} from './queries-trash.js';

const PROJECT_DELETED = '11111111-1111-4111-8111-111111111111';
const PROJECT_ACTIVE = '22222222-2222-4222-8222-222222222222';
const PROJECT_SYSTEM = '33333333-3333-4333-8333-333333333333';
const SESSION_PROJECT = '44444444-4444-4444-8444-444444444444';
const SESSION_PROJECT_2 = '55555555-5555-4555-8555-555555555555';
const SESSION_SINGLE = '66666666-6666-4666-8666-666666666666';

async function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trash-delete-'));
  const dbPath = path.join(directory, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      pinned INTEGER DEFAULT 0, pinned_at INTEGER, is_system INTEGER DEFAULT 0, deleted_at INTEGER
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, title_manually_set INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER DEFAULT 0, pinned_at INTEGER,
      archived INTEGER DEFAULT 0, project_id TEXT, engine TEXT, engine_session_id TEXT, engine_metadata TEXT,
      codex_thread_id TEXT, codex_archived INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'idle',
      token_usage TEXT, active_turn_usage TEXT, active_attempt_id TEXT, deleted_at INTEGER
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, metadata TEXT);
    CREATE TABLE shared_records (id TEXT PRIMARY KEY, source_session_id TEXT);
    CREATE TABLE context_compaction_events (session_id TEXT, thread_id TEXT, turn_id TEXT);
    CREATE TABLE engine_turn_facts (id TEXT PRIMARY KEY, session_id TEXT, attempt_id TEXT);
    CREATE TABLE engine_terminal_decisions (id TEXT PRIMARY KEY, session_id TEXT, attempt_id TEXT, fact_id TEXT);
    CREATE TABLE engine_queue_entries (id TEXT PRIMARY KEY, session_id TEXT, attempt_id TEXT, user_message_id TEXT);
    CREATE TABLE engine_resource_leases (attempt_id TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE engine_capacity_events (id TEXT PRIMARY KEY, attempt_id TEXT);
    CREATE TABLE engine_provider_cooldowns (resource_key TEXT PRIMARY KEY, probe_attempt_id TEXT);
    CREATE TABLE sidebar_order_scopes (scope TEXT PRIMARY KEY, updated_at INTEGER);
    CREATE TABLE sidebar_order_items (scope TEXT, item_type TEXT, item_id TEXT, position INTEGER);

    INSERT INTO projects VALUES
      ('${PROJECT_DELETED}', '已删项目', 'D:/deleted', 1, 10, 0, NULL, 0, 10),
      ('${PROJECT_ACTIVE}', '有效项目', 'D:/active', 1, 10, 0, NULL, 0, NULL),
      ('${PROJECT_SYSTEM}', '异常默认项目', 'D:/system', 1, 10, 0, NULL, 1, 10);
    INSERT INTO sessions (id, title, created_at, updated_at, project_id, engine, status, active_attempt_id, deleted_at) VALUES
      ('${SESSION_PROJECT}', '项目会话一', 1, 10, '${PROJECT_DELETED}', 'codex', 'idle', 'attempt-project', 10),
      ('${SESSION_PROJECT_2}', '项目会话二', 1, 10, '${PROJECT_DELETED}', 'codebuddy', 'idle', NULL, 10),
      ('${SESSION_SINGLE}', '单独删除', 1, 10, '${PROJECT_ACTIVE}', 'codex', 'idle', 'attempt-single', 10);
    INSERT INTO messages VALUES
      ('77777777-7777-4777-8777-777777777777', '${SESSION_PROJECT}', '{"attachments":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","kind":"uploaded_file","name":"a.txt","path":"D:/deleted/.relay_upload/messages/77777777-7777-4777-8777-777777777777/a.txt","size":12,"mimeType":"text/plain","available":true}]}'),
      ('88888888-8888-4888-8888-888888888888', '${SESSION_PROJECT_2}', NULL),
      ('99999999-9999-4999-8999-999999999999', '${SESSION_SINGLE}', NULL);
    INSERT INTO shared_records VALUES ('share-project', '${SESSION_PROJECT}'), ('share-single', '${SESSION_SINGLE}');
    INSERT INTO context_compaction_events VALUES ('${SESSION_PROJECT}', 'thread', 'turn');
    INSERT INTO engine_turn_facts VALUES ('fact-project', '${SESSION_PROJECT}', 'attempt-project'), ('fact-single', '${SESSION_SINGLE}', 'attempt-single');
    INSERT INTO engine_terminal_decisions VALUES ('decision-project', '${SESSION_PROJECT}', 'attempt-project', 'fact-project'), ('decision-single', '${SESSION_SINGLE}', 'attempt-single', 'fact-single');
    INSERT INTO engine_queue_entries VALUES ('queue-project', '${SESSION_PROJECT}', 'attempt-project', '77777777-7777-4777-8777-777777777777');
    INSERT INTO engine_resource_leases VALUES ('attempt-project', '${SESSION_PROJECT}'), ('attempt-single', '${SESSION_SINGLE}');
    INSERT INTO engine_capacity_events VALUES ('capacity-project', 'attempt-project'), ('capacity-single', 'attempt-single'), ('capacity-global', NULL);
    INSERT INTO engine_provider_cooldowns VALUES ('codex:project', 'attempt-project'), ('codex:single', 'attempt-single'), ('codex:global', NULL);
    INSERT INTO sidebar_order_scopes VALUES ('projects', 1), ('project:${PROJECT_DELETED}', 1), ('project:${PROJECT_ACTIVE}', 1);
    INSERT INTO sidebar_order_items VALUES
      ('projects', 'project', '${PROJECT_DELETED}', 0),
      ('project:${PROJECT_DELETED}', 'session', '${SESSION_PROJECT}', 0),
      ('project:${PROJECT_ACTIVE}', 'session', '${SESSION_SINGLE}', 0);
  `);
  const db = new SQLiteDB(raw, dbPath);
  ensureTrashCleanupJobsTable(db);
  ensureWorkspaceConsoleLinksTable(db);
  db.run(`INSERT INTO workspace_console_links
    (id, workspace_path, task_id, session_id, relation_source, confidence, created_at, updated_at)
    VALUES ('link-project', 'D:/fixed', 'task-a', ?, 'explicit', 'high', 1, 1),
           ('link-single', 'D:/fixed', 'task-b', ?, 'explicit', 'high', 1, 1)`, [SESSION_PROJECT, SESSION_SINGLE]);
  return { db, dbPath, directory, cleanup: () => { db.raw().close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function job(operationId: string) {
  return {
    operationId,
    quarantinePath: `D:/project/.relay_upload/.trash-quarantine/${operationId}`,
    createdAt: 100,
  };
}

function databaseWithOverrides(
  db: SQLiteDB,
  overrides: Partial<Pick<SQLiteDB, 'run' | 'saveToFile'>>,
) {
  return {
    all: db.all.bind(db),
    get: db.get.bind(db),
    run: overrides.run ?? db.run.bind(db),
    exec: db.exec.bind(db),
    saveToFile: overrides.saveToFile ?? db.saveToFile.bind(db),
    raw: db.raw.bind(db),
    restoreFromBytes: db.restoreFromBytes.bind(db),
  };
}

test('项目永久删除清理完整关系集合，最后删除项目并只保存一次', async () => {
  const current = await harness();
  try {
    let saves = 0;
    const originalSave = current.db.saveToFile.bind(current.db);
    current.db.saveToFile = () => { saves += 1; originalSave(); };
    const result = permanentlyDeleteProjectInDatabase(current.db, PROJECT_DELETED, job('op-project'));
    assert.equal(result.status, 'deleted');
    assert.equal(saves, 1);
    for (const table of ['shared_records', 'context_compaction_events', 'engine_terminal_decisions', 'engine_turn_facts', 'engine_queue_entries', 'messages']) {
      assert.equal(current.db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === 'messages' ? 'session_id' : table === 'shared_records' ? 'source_session_id' : 'session_id'} IN (?, ?)`, [SESSION_PROJECT, SESSION_PROJECT_2])?.count, 0, table);
    }
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM engine_resource_leases WHERE session_id IN (?, ?)', [SESSION_PROJECT, SESSION_PROJECT_2])?.count, 0);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM engine_capacity_events WHERE id = 'capacity-project'")?.count, 0);
    assert.equal(current.db.get("SELECT probe_attempt_id FROM engine_provider_cooldowns WHERE resource_key = 'codex:project'")?.probe_attempt_id, null);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?', [PROJECT_DELETED])?.count, 0);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM projects WHERE id = ?', [PROJECT_DELETED])?.count, 0);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM sidebar_order_scopes WHERE scope = ?", [`project:${PROJECT_DELETED}`])?.count, 0);
    assert.equal(current.db.get("SELECT status FROM trash_attachment_cleanup_jobs WHERE operation_id = 'op-project'")?.status, 'pending');
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM engine_capacity_events WHERE id = 'capacity-global'")?.count, 1);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM workspace_console_links WHERE id = 'link-project'")?.count, 0);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM workspace_console_links WHERE id = 'link-single'")?.count, 1);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM sessions WHERE id = ?", [SESSION_SINGLE])?.count, 1);
  } finally { current.cleanup(); }
});

test('单会话永久删除只清理目标关系并保留父项目', async () => {
  const current = await harness();
  try {
    const result = permanentlyDeleteSessionInDatabase(current.db, SESSION_SINGLE, undefined);
    assert.equal(result.status, 'deleted');
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM sessions WHERE id = ?', [SESSION_SINGLE])?.count, 0);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM projects WHERE id = ?', [PROJECT_ACTIVE])?.count, 1);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM shared_records WHERE id = 'share-single'")?.count, 0);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM engine_turn_facts WHERE id = 'fact-single'")?.count, 0);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM workspace_console_links WHERE id = 'link-single'")?.count, 0);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM trash_attachment_cleanup_jobs")?.count, 0);
  } finally { current.cleanup(); }
});

test('已删除的系统初始项目允许永久删除', async () => {
  const current = await harness();
  try {
    assert.equal(permanentlyDeleteProjectInDatabase(current.db, PROJECT_SYSTEM, undefined).status, 'deleted');
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM projects WHERE id = ?', [PROJECT_SYSTEM])?.count, 0);
  } finally { current.cleanup(); }
});

test('任一 SQL 失败时回滚业务记录、分享和 cleanup job', async () => {
  const current = await harness();
  try {
    const originalRun = current.db.run.bind(current.db);
    const failing = databaseWithOverrides(current.db, {
      run: (sql: string, params: any[] = []) => {
        if (sql.startsWith('DELETE FROM messages')) throw new Error('injected sql failure');
        originalRun(sql, params);
      },
    });
    assert.throws(() => permanentlyDeleteProjectInDatabase(failing, PROJECT_DELETED, job('op-sql-fail')), /injected sql failure/);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM projects WHERE id = ?', [PROJECT_DELETED])?.count, 1);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM shared_records WHERE id = 'share-project'")?.count, 1);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM trash_attachment_cleanup_jobs WHERE operation_id = 'op-sql-fail'")?.count, 0);
  } finally { current.cleanup(); }
});

test('saveToFile 失败时恢复提交前内存快照，不形成部分成功', async () => {
  const current = await harness();
  try {
    const failing = databaseWithOverrides(current.db, {
      saveToFile: () => { throw new Error('injected save failure'); },
    });
    assert.throws(() => permanentlyDeleteProjectInDatabase(failing, PROJECT_DELETED, job('op-save-fail')), /injected save failure/);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM projects WHERE id = ?', [PROJECT_DELETED])?.count, 1);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM shared_records WHERE id = 'share-project'")?.count, 1);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM trash_attachment_cleanup_jobs WHERE operation_id = 'op-save-fail'")?.count, 0);
  } finally { current.cleanup(); }
});
