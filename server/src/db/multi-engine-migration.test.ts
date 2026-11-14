import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { ensureSessionEngineColumns, SQLiteDB } from './index.js';
import { ensureOpenCodeEngineCheckSupport } from './opencode-engine-migration.js';

async function createLegacyDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_system INTEGER DEFAULT 0
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      codex_thread_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    INSERT INTO projects (id, name, path, created_at, updated_at, is_system)
    VALUES ('default-project', 'Relay 工作区', 'D:/relay/workspace', 1, 1, 1);
    INSERT INTO sessions (id, title, project_id, codex_thread_id, updated_at)
    VALUES ('legacy-session', '旧会话', 'default-project', 'thread-1', 2);
    INSERT INTO messages (id, session_id, content)
    VALUES ('message-1', 'legacy-session', '历史消息');
  `);
  return { raw, db: new SQLiteDB(raw, ':memory:') };
}

test('多引擎迁移将旧会话回填为 Codex 且保持项目、会话和消息不变', async () => {
  const { raw, db } = await createLegacyDatabase();
  try {
    assert.equal(ensureSessionEngineColumns(db), true);

    assert.deepEqual(
      db.get('SELECT id, engine, engine_bound, engine_session_id, engine_metadata, codex_thread_id FROM sessions'),
      {
        id: 'legacy-session',
        engine: 'codex',
        engine_bound: 1,
        engine_session_id: 'thread-1',
        engine_metadata: null,
        codex_thread_id: 'thread-1',
      },
    );
    assert.equal(db.get('SELECT COUNT(*) AS count FROM projects')?.count, 1);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM sessions')?.count, 1);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM messages')?.count, 1);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally {
    raw.close();
  }
});

test('多引擎迁移允许同一项目混合会话并约束外部会话 ID 唯一', async () => {
  const { raw, db } = await createLegacyDatabase();
  try {
    ensureSessionEngineColumns(db);
    db.run(
      `INSERT INTO sessions
       (id, title, project_id, codex_thread_id, updated_at, engine, engine_session_id, engine_metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['codebuddy-session', 'CodeBuddy', 'default-project', null, 3, 'codebuddy', 'acp-1', '{"source":"fixture"}'],
    );

    assert.deepEqual(
      db.all('SELECT id, engine FROM sessions ORDER BY id'),
      [
        { id: 'codebuddy-session', engine: 'codebuddy' },
        { id: 'legacy-session', engine: 'codex' },
      ],
    );
    assert.throws(() => {
      db.run(
        `INSERT INTO sessions
         (id, title, project_id, codex_thread_id, updated_at, engine, engine_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['duplicate', '重复', 'default-project', null, 4, 'codebuddy', 'acp-1'],
      );
    }, /UNIQUE constraint failed/);
  } finally {
    raw.close();
  }
});

test('多引擎迁移可修复只有 engine 列的半迁移数据库', async () => {
  const { raw, db } = await createLegacyDatabase();
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'codex'");
    assert.equal(ensureSessionEngineColumns(db), true);
    const columns = new Set(db.all('PRAGMA table_info(sessions)').map((column) => column.name));
    assert.equal(columns.has('engine_session_id'), true);
    assert.equal(columns.has('engine_bound'), true);
    assert.equal(columns.has('engine_metadata'), true);
    assert.equal(db.get('SELECT engine_session_id FROM sessions')?.engine_session_id, 'thread-1');
    const indexes = new Set(db.all('PRAGMA index_list(sessions)').map((index) => index.name));
    assert.equal(indexes.has('idx_sessions_engine_external_id'), true);
    assert.equal(indexes.has('idx_sessions_project_engine_updated'), true);
    assert.equal(ensureSessionEngineColumns(db), false);
  } finally {
    raw.close();
  }
});

test('多引擎迁移失败时回滚全部新增列并恢复外键设置', async () => {
  const { raw, db } = await createLegacyDatabase();
  try {
    assert.throws(
      () => ensureSessionEngineColumns(db, { beforeCommit: () => { throw new Error('模拟迁移失败'); } }),
      /模拟迁移失败/,
    );
    assert.equal(db.all('PRAGMA table_info(sessions)').some((column) => column.name === 'engine'), false);
    assert.equal(db.get('PRAGMA foreign_keys')?.foreign_keys, 1);
  } finally {
    raw.close();
  }
});

test('多引擎迁移后引擎 CHECK 放开 opencode 且保留数据', async () => {
  const { raw, db } = await createLegacyDatabase();
  try {
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    db.exec("ALTER TABLE sessions ADD COLUMN created_at INTEGER");
    db.exec('UPDATE sessions SET created_at = updated_at WHERE created_at IS NULL');
    db.exec("ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'codex' CHECK(engine IN ('codex','codebuddy'))");
    db.exec("ALTER TABLE sessions ADD COLUMN engine_bound INTEGER NOT NULL DEFAULT 1 CHECK(engine_bound IN (0,1))");
    db.exec('ALTER TABLE sessions ADD COLUMN engine_session_id TEXT');
    db.exec('ALTER TABLE sessions ADD COLUMN engine_metadata TEXT');
    assert.equal(ensureOpenCodeEngineCheckSupport(db), true);

    db.run(
      `INSERT INTO sessions
       (id, title, project_id, codex_thread_id, updated_at, created_at, engine, engine_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['opencode-session', 'OpenCode 会话', 'default-project', null, 5, 5, 'opencode', 'acp-1'],
    );
    assert.equal(db.get('SELECT engine FROM sessions WHERE id = ?', ['opencode-session'])?.engine, 'opencode');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM sessions')?.count, 2);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM projects')?.count, 1);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM messages')?.count, 1);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    assert.equal(ensureOpenCodeEngineCheckSupport(db), false);
  } finally {
    raw.close();
  }
});
