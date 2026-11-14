import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { claimNextQueuedEntryInDatabase, ensureEngineConcurrencyTables, insertQueuedTurnInDatabase } from '../db/engine-concurrency.js';
import { SQLiteDB } from '../db/index.js';
import { createEngineConcurrencyApi } from './engine-concurrency-api.js';

test('并发快照按 actor 投影本人事实，管理员读取全局事实', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, engine TEXT NOT NULL, status TEXT NOT NULL, active_attempt_id TEXT, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE);
    INSERT INTO users VALUES ('user-a'), ('user-b');
    INSERT INTO sessions VALUES
      ('session-a1', 'codex', 'idle', NULL, 1, NULL),
      ('session-a2', 'codex', 'idle', NULL, 1, NULL),
      ('33333333-3333-4333-8333-333333333333', 'codex', 'idle', NULL, 1, NULL);
    INSERT INTO messages VALUES
      ('message-a1', 'session-a1'), ('message-a2', 'session-a2'), ('message-b1', '33333333-3333-4333-8333-333333333333');
  `);
  const db = new SQLiteDB(raw, ':memory:');
  try {
    ensureEngineConcurrencyTables(db);
    for (const entry of [
      { id: 'queue-a1', sessionId: 'session-a1', attemptId: 'attempt-a1', userMessageId: 'message-a1', requestedByUserId: 'user-a', createdAt: 1 },
      { id: 'queue-a2', sessionId: 'session-a2', attemptId: 'attempt-a2', userMessageId: 'message-a2', requestedByUserId: 'user-a', createdAt: 2 },
      { id: '44444444-4444-4444-8444-444444444444', sessionId: '33333333-3333-4333-8333-333333333333', attemptId: 'attempt-b1', userMessageId: 'message-b1', requestedByUserId: 'user-b', createdAt: 3 },
    ]) insertQueuedTurnInDatabase(db, { ...entry, engineId: 'codex', resourceKey: 'codex:default' });
    claimNextQueuedEntryInDatabase(db, {
      resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: 'claim-a1', now: 10,
    });
    const api = createEngineConcurrencyApi({
      registry: { list: () => [{
        id: 'codex', concurrency: { resolveResource: () => ({
          resourceKey: 'codex:default', providerKey: null, label: 'Codex', defaultMaxActiveTurns: 2,
        }) },
      }] } as any,
      getDb: () => db,
      broadcast: () => undefined,
      drain: async () => undefined,
      now: () => 20,
    });

    assert.deepEqual(api.listSnapshots({ id: 'user-a', role: 'member' }).map(({ activeTurns, queuedTurns }) => ({ activeTurns, queuedTurns })), [
      { activeTurns: 1, queuedTurns: 1 },
    ]);
    assert.deepEqual(api.listSnapshots({ id: 'user-b', role: 'member' }).map(({ activeTurns, queuedTurns }) => ({ activeTurns, queuedTurns })), [
      { activeTurns: 0, queuedTurns: 1 },
    ]);
    assert.deepEqual(api.listSnapshots({ id: 'admin', role: 'admin' }).map(({ activeTurns, queuedTurns }) => ({ activeTurns, queuedTurns })), [
      { activeTurns: 1, queuedTurns: 2 },
    ]);
    assert.equal(api.getQueueSnapshot('33333333-3333-4333-8333-333333333333')?.position, 1);
  } finally {
    raw.close();
  }
});
