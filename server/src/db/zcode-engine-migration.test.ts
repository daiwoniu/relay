import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { ensureZcodeEngineCheckSupport } from './zcode-engine-migration.js';

async function createOpenCodeEngineDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_system INTEGER DEFAULT 0
    );
    INSERT INTO projects (id, name, path, created_at, updated_at, is_system)
    VALUES ('default-project', 'Relay 工作区', 'D:/relay/workspace', 1, 1, 1);

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      default_engine TEXT NOT NULL DEFAULT 'codex' CHECK(default_engine IN ('codex','codebuddy','opencode')),
      default_model_id TEXT,
      can_create_project INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO users (id, username, password_hash, role, default_engine, default_model_id, can_create_project, created_at, updated_at)
    VALUES ('user-1', 'admin', 'hash', 'admin', 'codex', 'model-x', 1, 1, 1);

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      engine TEXT NOT NULL DEFAULT 'codex' CHECK(engine IN ('codex','codebuddy','opencode')),
      engine_bound INTEGER NOT NULL DEFAULT 1 CHECK(engine_bound IN (0,1)),
      engine_session_id TEXT,
      engine_metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO sessions (id, title, project_id, owner_user_id, engine, created_at, updated_at)
    VALUES ('codex-session', '旧 Codex 会话', 'default-project', 'user-1', 'codex', 2, 2);
    INSERT INTO sessions (id, title, project_id, owner_user_id, engine, created_at, updated_at)
    VALUES ('opencode-session', 'OpenCode 会话', 'default-project', 'user-1', 'opencode', 3, 3);
    CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
    CREATE UNIQUE INDEX idx_sessions_engine_external_id
      ON sessions(engine, engine_session_id) WHERE engine_session_id IS NOT NULL;

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    INSERT INTO messages (id, session_id, content) VALUES ('message-1', 'codex-session', '历史内容');

    CREATE TABLE engine_turn_facts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      engine TEXT NOT NULL CHECK(engine IN ('codex','codebuddy','opencode')),
      connection_id TEXT NOT NULL,
      external_session_id TEXT,
      external_turn_id TEXT,
      fact_type TEXT NOT NULL,
      source TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      observed_at INTEGER NOT NULL,
      safe_payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO engine_turn_facts
      (id, session_id, attempt_id, engine, connection_id, fact_type, source,
       sequence, idempotency_key, observed_at, safe_payload_json, created_at)
    VALUES ('fact-1', 'codex-session', 'attempt-1', 'codex', 'conn-1', 'turn_started', 'local',
            1, 'fact-key-1', 2, '{}', 2);
    CREATE INDEX idx_engine_turn_facts_attempt
      ON engine_turn_facts(session_id, attempt_id, observed_at, sequence);

    CREATE TABLE engine_terminal_decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      engine TEXT NOT NULL CHECK(engine IN ('codex','codebuddy','opencode')),
      external_turn_id TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed','interrupted','stopped')),
      reason_code TEXT NOT NULL,
      fact_id TEXT NOT NULL REFERENCES engine_turn_facts(id) ON DELETE RESTRICT,
      decided_at INTEGER NOT NULL,
      projected_at INTEGER,
      UNIQUE(session_id, engine, attempt_id)
    );
    INSERT INTO engine_terminal_decisions
      (id, session_id, attempt_id, engine, outcome, reason_code, fact_id, decided_at)
    VALUES ('decision-1', 'codex-session', 'attempt-1', 'codex', 'completed', 'completed_final_answer', 'fact-1', 3);
    CREATE INDEX idx_engine_terminal_decisions_session
      ON engine_terminal_decisions(session_id, decided_at DESC);

    CREATE TABLE engine_concurrency_settings (
      resource_key TEXT PRIMARY KEY,
      engine_id TEXT NOT NULL CHECK(engine_id IN ('codex','codebuddy','opencode')),
      max_active_turns INTEGER NOT NULL CHECK(max_active_turns BETWEEN 1 AND 32),
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO engine_concurrency_settings (resource_key, engine_id, max_active_turns, updated_at)
    VALUES ('proj:default-project', 'opencode', 2, 4);

    CREATE TABLE engine_queue_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL UNIQUE,
      user_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      engine_id TEXT NOT NULL CHECK(engine_id IN ('codex','codebuddy','opencode')),
      resource_key TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('queued','claimed')),
      claim_token TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER
    );
    INSERT INTO engine_queue_entries
      (id, session_id, attempt_id, user_message_id, engine_id, resource_key,
       requested_by_user_id, state, created_at)
    VALUES ('queue-1', 'codex-session', 'attempt-1', 'message-1', 'codex', 'proj:default-project',
            'user-1', 'queued', 4);
    CREATE INDEX idx_engine_queue_fifo ON engine_queue_entries(resource_key, state, created_at, id);

    CREATE TABLE engine_resource_leases (
      attempt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      engine_id TEXT NOT NULL CHECK(engine_id IN ('codex','codebuddy','opencode')),
      resource_key TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('claimed','running')),
      acquired_at INTEGER NOT NULL,
      started_at INTEGER
    );
    INSERT INTO engine_resource_leases
      (attempt_id, session_id, engine_id, resource_key, lease_token, state, acquired_at)
    VALUES ('lease-1', 'opencode-session', 'opencode', 'proj:default-project', 'token-1', 'running', 4);
    CREATE INDEX idx_engine_leases_resource ON engine_resource_leases(resource_key, state, acquired_at);
  `);
  return { raw, db: new SQLiteDB(raw, ':memory:') };
}

test('存量库引擎 CHECK 迁移放开 zcode 且保留数据、索引与外键', async () => {
  const { raw, db } = await createOpenCodeEngineDatabase();
  try {
    assert.equal(ensureZcodeEngineCheckSupport(db), true);

    assert.equal(db.get('SELECT COUNT(*) AS count FROM sessions')?.count, 2);
    assert.equal(db.get('SELECT engine FROM sessions WHERE id = ?', ['codex-session'])?.engine, 'codex');
    assert.equal(db.get('SELECT engine FROM sessions WHERE id = ?', ['opencode-session'])?.engine, 'opencode');
    assert.equal(db.get('SELECT default_engine FROM users WHERE id = ?', ['user-1'])?.default_engine, 'codex');
    assert.equal(db.get('SELECT can_create_project FROM users WHERE id = ?', ['user-1'])?.can_create_project, 1);
    assert.equal(db.get('SELECT default_model_id FROM users WHERE id = ?', ['user-1'])?.default_model_id, 'model-x');
    assert.equal(db.get('SELECT engine FROM engine_turn_facts WHERE id = ?', ['fact-1'])?.engine, 'codex');
    assert.equal(db.get('SELECT engine FROM engine_terminal_decisions WHERE id = ?', ['decision-1'])?.engine, 'codex');
    assert.equal(db.get('SELECT engine_id FROM engine_concurrency_settings WHERE resource_key = ?', ['proj:default-project'])?.engine_id, 'opencode');
    assert.equal(db.get('SELECT engine_id FROM engine_queue_entries WHERE id = ?', ['queue-1'])?.engine_id, 'codex');
    assert.equal(db.get('SELECT engine_id FROM engine_resource_leases WHERE attempt_id = ?', ['lease-1'])?.engine_id, 'opencode');

    const indexNames = (table: string) => new Set(db.all(`PRAGMA index_list(${table})`).map((index) => index.name));
    assert.equal(indexNames('sessions').has('idx_sessions_updated'), true);
    assert.equal(indexNames('sessions').has('idx_sessions_engine_external_id'), true);
    assert.equal(indexNames('engine_turn_facts').has('idx_engine_turn_facts_attempt'), true);
    assert.equal(indexNames('engine_terminal_decisions').has('idx_engine_terminal_decisions_session'), true);
    assert.equal(indexNames('engine_queue_entries').has('idx_engine_queue_fifo'), true);
    assert.equal(indexNames('engine_resource_leases').has('idx_engine_leases_resource'), true);

    db.exec(
      `INSERT INTO sessions (id, title, engine, created_at, updated_at)
       VALUES ('zcode-session', 'ZCode 会话', 'zcode', 6, 6)`,
    );
    db.run('UPDATE users SET default_engine = ? WHERE id = ?', ['zcode', 'user-1']);
    db.run(
      `INSERT INTO engine_turn_facts
       (id, session_id, attempt_id, engine, connection_id, fact_type, source,
        sequence, idempotency_key, observed_at, safe_payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['fact-2', 'zcode-session', 'zcode-attempt', 'zcode', 'conn-2', 'turn_started', 'local',
        1, 'fact-key-2', 6, '{}', 6],
    );
    db.run(
      `INSERT INTO engine_terminal_decisions
       (id, session_id, attempt_id, engine, outcome, reason_code, fact_id, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['decision-2', 'zcode-session', 'zcode-attempt', 'zcode', 'completed', 'completed_final_answer', 'fact-2', 6],
    );
    db.run(
      `INSERT INTO engine_concurrency_settings (resource_key, engine_id, max_active_turns, updated_at)
       VALUES (?, ?, ?, ?)`,
      ['proj:zcode', 'zcode', 1, 6],
    );
    db.run(
      `INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)`,
      ['message-2', 'zcode-session', 'ZCode 内容'],
    );
    db.run(
      `INSERT INTO engine_queue_entries
       (id, session_id, attempt_id, user_message_id, engine_id, resource_key,
        requested_by_user_id, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['queue-2', 'zcode-session', 'zcode-attempt', 'message-2', 'zcode', 'proj:zcode',
        'user-1', 'queued', 6],
    );
    db.run(
      `INSERT INTO engine_resource_leases
       (attempt_id, session_id, engine_id, resource_key, lease_token, state, acquired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['zcode-lease', 'zcode-session', 'zcode', 'proj:zcode', 'zcode-token', 'claimed', 6],
    );

    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    assert.equal(ensureZcodeEngineCheckSupport(db), false);
  } finally {
    raw.close();
  }
});

test('已含 zcode 的空库结构不重复迁移', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      default_engine TEXT NOT NULL DEFAULT 'codex'
        CHECK(default_engine IN ('codex','codebuddy','opencode','zcode'))
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'codex'
        CHECK(engine IN ('codex','codebuddy','opencode','zcode')),
      updated_at INTEGER NOT NULL
    );
  `);
  const db = new SQLiteDB(raw, ':memory:');
  try {
    assert.equal(ensureZcodeEngineCheckSupport(db), false);
    db.run(
      "INSERT INTO sessions (id, title, engine, updated_at) VALUES ('s1', '新会话', 'zcode', 1)",
    );
    assert.equal(db.get("SELECT COUNT(*) AS count FROM sessions WHERE engine = 'zcode'")?.count, 1);
  } finally {
    raw.close();
  }
});

test('非法引擎值仍被 CHECK 拒绝', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'codex'
        CHECK(engine IN ('codex','codebuddy','opencode','zcode')),
      updated_at INTEGER NOT NULL
    );
  `);
  const db = new SQLiteDB(raw, ':memory:');
  try {
    assert.throws(() => {
      db.run(
        "INSERT INTO sessions (id, title, engine, updated_at) VALUES ('s1', '非法会话', 'unknown-engine', 1)",
      );
    });
  } finally {
    raw.close();
  }
});
