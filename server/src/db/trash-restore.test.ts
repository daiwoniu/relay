import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import {
  restoreProjectFromTrashInDatabase,
  restoreSessionFromTrashInDatabase,
} from './queries-trash.js';

async function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trash-restore-'));
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
      codex_thread_id TEXT, codex_archived INTEGER DEFAULT 0, codex_archived_for_trash INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle',
      token_usage TEXT, active_turn_usage TEXT, message_revision INTEGER DEFAULT 0,
      context_compaction_count INTEGER DEFAULT 0, selected_model_id TEXT, selected_reasoning_effort TEXT,
      engine_preferences_revision INTEGER DEFAULT 0, deleted_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE sidebar_order_items (scope TEXT, item_type TEXT, item_id TEXT, position INTEGER);
    INSERT INTO projects VALUES
      ('11111111-1111-4111-8111-111111111111', '已删项目', 'D:/deleted', 1, 10, 1, 9, 0, 100),
      ('22222222-2222-4222-8222-222222222222', '有效项目', 'D:/active', 1, 10, 0, NULL, 0, NULL),
      ('33333333-3333-4333-8333-333333333333', '异常默认项目', 'D:/system', 1, 10, 0, NULL, 1, 100);
    INSERT INTO sessions (id, title, created_at, updated_at, pinned, pinned_at, project_id, engine, status, deleted_at) VALUES
      ('44444444-4444-4444-8444-444444444444', '随项目删除', 1, 10, 1, 9, '11111111-1111-4111-8111-111111111111', 'codex', 'idle', 100),
      ('55555555-5555-4555-8555-555555555555', '更早单删', 1, 8, 1, 7, '11111111-1111-4111-8111-111111111111', 'codebuddy', 'idle', 80),
      ('66666666-6666-4666-8666-666666666666', '独立删除', 1, 11, 1, 10, '22222222-2222-4222-8222-222222222222', 'codex', 'idle', 110);
    INSERT INTO sidebar_order_items VALUES
      ('projects', 'project', '11111111-1111-4111-8111-111111111111', 0),
      ('project:11111111-1111-4111-8111-111111111111', 'session', '44444444-4444-4444-8444-444444444444', 0),
      ('project:22222222-2222-4222-8222-222222222222', 'session', '66666666-6666-4666-8666-666666666666', 0);
  `);
  const db = new SQLiteDB(raw, path.join(directory, 'relay.db'));
  return { db, raw, cleanup: () => { raw.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('恢复项目原子恢复项目及全部会话并重置排序状态', async () => {
  const current = await harness();
  try {
    const result = restoreProjectFromTrashInDatabase(current.db, '11111111-1111-4111-8111-111111111111', 500);
    assert.equal(result?.project.deleted_at, null);
    assert.deepEqual(result?.sessions.map((session) => session.id), [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ]);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM sessions WHERE project_id = '11111111-1111-4111-8111-111111111111' AND deleted_at IS NULL")?.count, 2);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM sessions WHERE project_id = '11111111-1111-4111-8111-111111111111' AND pinned != 0")?.count, 0);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM sidebar_order_items WHERE item_id IN ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444')")?.count, 0);
  } finally { current.cleanup(); }
});

test('完成回收站取消归档时同时清除归档事实与来源标记', async () => {
  const current = await harness();
  try {
    current.db.run(
      'UPDATE sessions SET codex_archived = 1, codex_archived_for_trash = 1 WHERE id = ?',
      ['66666666-6666-4666-8666-666666666666'],
    );
    restoreSessionFromTrashInDatabase(current.db, '66666666-6666-4666-8666-666666666666', 500);
    const { completeSessionTrashUnarchiveInDatabase } = await import('./queries-trash.js');
    const completed = completeSessionTrashUnarchiveInDatabase(current.db, '66666666-6666-4666-8666-666666666666', 600);
    assert.equal(completed?.codex_archived, 0);
    assert.equal(completed?.codex_archived_for_trash, 0);
    assert.equal(completed?.updated_at, 600);
  } finally { current.cleanup(); }
});

test('批量完成多个回收站取消归档只保存一次数据库', async () => {
  const current = await harness();
  try {
    current.db.run(
      "UPDATE sessions SET codex_archived = 1, codex_archived_for_trash = 1, deleted_at = NULL WHERE id IN (?, ?)",
      ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'],
    );
    let saves = 0;
    const originalSave = current.db.saveToFile.bind(current.db);
    current.db.saveToFile = () => { saves += 1; };
    const { completeSessionTrashUnarchivesInDatabase } = await import('./queries-trash.js');
    const completed = completeSessionTrashUnarchivesInDatabase(current.db, [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ], 600);
    current.db.saveToFile = originalSave;
    assert.equal(saves, 1);
    assert.deepEqual(completed.map((session) => session.id), [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ]);
    assert.ok(completed.every((session) => session.codex_archived === 0 && session.codex_archived_for_trash === 0));
  } finally { current.cleanup(); }
});

test('单会话只在父项目有效时恢复，已删除的系统初始项目允许恢复', async () => {
  const current = await harness();
  try {
    assert.equal(restoreSessionFromTrashInDatabase(current.db, '44444444-4444-4444-8444-444444444444', 500), undefined);
    assert.equal(restoreProjectFromTrashInDatabase(current.db, '33333333-3333-4333-8333-333333333333', 500)?.project.deleted_at, null);
    const restored = restoreSessionFromTrashInDatabase(current.db, '66666666-6666-4666-8666-666666666666', 500);
    assert.equal(restored?.deleted_at, null);
    assert.equal(restored?.pinned, 0);
  } finally { current.cleanup(); }
});

test('恢复项目保存失败时恢复提交前内存快照', async () => {
  const current = await harness();
  try {
    const failing = {
      all: current.db.all.bind(current.db),
      get: current.db.get.bind(current.db),
      run: current.db.run.bind(current.db),
      exec: current.db.exec.bind(current.db),
      saveToFile: () => { throw new Error('injected save failure'); },
      raw: current.db.raw.bind(current.db),
      restoreFromBytes: current.db.restoreFromBytes.bind(current.db),
    };
    assert.throws(
      () => restoreProjectFromTrashInDatabase(failing, '11111111-1111-4111-8111-111111111111', 500),
      /injected save failure/,
    );
    assert.equal(current.db.get("SELECT deleted_at FROM projects WHERE id = '11111111-1111-4111-8111-111111111111'")?.deleted_at, 100);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM sessions WHERE project_id = '11111111-1111-4111-8111-111111111111' AND deleted_at IS NULL")?.count, 0);
  } finally { current.cleanup(); }
});

test('恢复单会话保存失败时恢复提交前内存快照', async () => {
  const current = await harness();
  try {
    const failing = {
      all: current.db.all.bind(current.db),
      get: current.db.get.bind(current.db),
      run: current.db.run.bind(current.db),
      exec: current.db.exec.bind(current.db),
      saveToFile: () => { throw new Error('injected save failure'); },
      raw: current.db.raw.bind(current.db),
      restoreFromBytes: current.db.restoreFromBytes.bind(current.db),
    };
    assert.throws(
      () => restoreSessionFromTrashInDatabase(failing, '66666666-6666-4666-8666-666666666666', 500),
      /injected save failure/,
    );
    assert.equal(current.db.get("SELECT deleted_at FROM sessions WHERE id = '66666666-6666-4666-8666-666666666666'")?.deleted_at, 110);
  } finally { current.cleanup(); }
});
