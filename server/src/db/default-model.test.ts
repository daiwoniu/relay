import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { setUserDefaultEngineInDatabase, setUserDefaultModelInDatabase } from './queries-account.js';

test('账号默认模型随默认引擎保存，并在切换引擎时清空', async () => {
  const SQL = await initSqlJs({ locateFile: () => 'node_modules/sql.js/dist/sql-wasm.wasm' });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, ':memory:');
  const repository = {
    run: db.run.bind(db),
    get: db.get.bind(db),
    saveToFile: () => undefined,
  };
  try {
    raw.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT,
      default_engine TEXT NOT NULL, default_model_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); INSERT INTO users VALUES ('u1', 'user', 'hash', 'member', 'codex', NULL, 1, 1);`);
    assert.equal(setUserDefaultModelInDatabase(repository, 'u1', 'gpt-selected', 2).default_model_id, 'gpt-selected');
    assert.equal(setUserDefaultEngineInDatabase(repository, 'u1', 'codex', 3).default_model_id, 'gpt-selected');
    const switched = setUserDefaultEngineInDatabase(repository, 'u1', 'codebuddy', 4);
    assert.equal(switched.default_engine, 'codebuddy');
    assert.equal(switched.default_model_id, null);
  } finally {
    raw.close();
  }
});
