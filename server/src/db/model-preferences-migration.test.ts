import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { ensureSessionModelPreferenceColumns, SQLiteDB } from './index.js';
import { getSessionInDatabase, updateSessionEnginePreferencesInDatabase } from './queries.js';

test('旧 sessions 表幂等补齐模型偏好列并以自动模式返回', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-model-preferences-'));
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, engine TEXT NOT NULL,
        engine_bound INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'idle',
        updated_at INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER
      );
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      INSERT INTO sessions VALUES ('session-1', '旧会话', 'codex', 0, 'idle', 1, NULL);
      INSERT INTO messages VALUES ('message-1', 'session-1');
    `);
    const db = new SQLiteDB(raw, path.join(tempDir, 'relay.db'));

    assert.equal(ensureSessionModelPreferenceColumns(db), true);
    assert.equal(ensureSessionModelPreferenceColumns(db), false);
    const columns = new Set(db.all('PRAGMA table_info(sessions)').map((column) => String(column.name)));
    assert.equal(columns.has('selected_model_id'), true);
    assert.equal(columns.has('selected_reasoning_effort'), true);
    assert.equal(columns.has('selected_service_tier'), true);
    assert.equal(columns.has('engine_preferences_revision'), true);
    const session = getSessionInDatabase(db, 'session-1');
    assert.equal(session?.engine, null);
    assert.equal(session?.selected_model_id, null);
    assert.equal(session?.selected_reasoning_effort, null);
    assert.equal(session?.selected_service_tier, null);
    assert.equal(session?.engine_preferences_revision, 0);

    const updated = updateSessionEnginePreferencesInDatabase(db, 'session-1', {
      modelId: 'gpt-5.6-terra', reasoningEffort: 'high', serviceTier: 'priority', expectedRevision: 0,
    });
    assert.equal(updated?.engine_preferences_revision, 1);
    assert.equal(updated?.selected_service_tier, 'priority');
    assert.equal(updated?.engine, null);
    db.run("UPDATE sessions SET status = 'processing' WHERE id = 'session-1'");
    assert.equal(updateSessionEnginePreferencesInDatabase(db, 'session-1', {
      modelId: null, reasoningEffort: null, expectedRevision: 1,
    }), undefined);
    assert.equal(getSessionInDatabase(db, 'session-1')?.engine_preferences_revision, 1);
    db.run("UPDATE sessions SET status = 'idle' WHERE id = 'session-1'");
    assert.equal(updateSessionEnginePreferencesInDatabase(db, 'session-1', {
      modelId: null, reasoningEffort: null, expectedRevision: 0,
    }), undefined);
    raw.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
