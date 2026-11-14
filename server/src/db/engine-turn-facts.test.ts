import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import {
  appendEngineTurnFactInDatabase,
  ensureEngineTurnFactTables,
  getEngineTerminalDecisionInDatabase,
  insertEngineTerminalDecisionInDatabase,
  listEngineTurnFactsInDatabase,
} from './engine-turn-facts.js';
import type { EngineTurnFact } from '../engine/turn-facts.js';

async function createLegacyDatabase() {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      status TEXT NOT NULL,
      active_turn_id TEXT,
      active_turn_started_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );
    INSERT INTO sessions VALUES ('active', 'codex', 'processing', 'turn-1', 100);
    INSERT INTO sessions VALUES ('idle', 'codebuddy', 'idle', NULL, NULL);
    INSERT INTO messages VALUES ('message-1', 'active');
  `);
  return { raw, db: new SQLiteDB(raw, ':memory:') };
}

function sampleFact(): EngineTurnFact {
  return {
    id: 'fact-1', sessionId: 'active', attemptId: 'attempt-1', engineId: 'codex',
    connectionId: 'connection-1', externalSessionId: 'thread-1', externalTurnId: 'turn-1',
    factType: 'engine_error', source: 'realtime', sequence: 2, idempotencyKey: 'codex:error:1',
    observedAt: 123, payload: { errorCode: 'PROVIDER_FAILED', retryable: false },
  };
}

test('事实表迁移幂等创建并为旧活动会话回填稳定 attempt', async () => {
  const { raw, db } = await createLegacyDatabase();
  try {
    assert.equal(ensureEngineTurnFactTables(db), true);
    assert.equal(db.all('PRAGMA table_info(sessions)').some((column) => column.name === 'active_attempt_id'), true);
    assert.equal(db.get("SELECT active_attempt_id FROM sessions WHERE id = 'active'")?.active_attempt_id, 'legacy:active:turn-1:100');
    assert.equal(db.get("SELECT active_attempt_id FROM sessions WHERE id = 'idle'")?.active_attempt_id, null);
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engine_turn_facts'")?.name, 'engine_turn_facts');
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engine_terminal_decisions'")?.name, 'engine_terminal_decisions');
    assert.equal(ensureEngineTurnFactTables(db), false);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM messages')?.count, 1);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally {
    raw.close();
  }
});

test('事实按幂等键去重并按观察顺序读取', async () => {
  const { raw, db } = await createLegacyDatabase();
  try {
    ensureEngineTurnFactTables(db);
    const first = appendEngineTurnFactInDatabase(db, sampleFact());
    const duplicate = appendEngineTurnFactInDatabase(db, { ...sampleFact(), id: 'fact-duplicate' });
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.fact.id, 'fact-1');
    assert.deepEqual(listEngineTurnFactsInDatabase(db, 'active', 'attempt-1').map((fact) => fact.id), ['fact-1']);
  } finally {
    raw.close();
  }
});

test('事实仓储拒绝不在白名单内的 payload 字段', async () => {
  const { raw, db } = await createLegacyDatabase();
  try {
    ensureEngineTurnFactTables(db);
    assert.throws(() => appendEngineTurnFactInDatabase(db, {
      ...sampleFact(),
      payload: { errorCode: 'PROVIDER_FAILED', retryable: false, content: '不得入库' } as never,
    }), /payload/i);
    assert.throws(() => appendEngineTurnFactInDatabase(db, {
      ...sampleFact(),
      id: 'fact-secret-code',
      idempotencyKey: 'fact-secret-code',
      payload: { errorCode: 'token=secret', retryable: false },
    }), /payload/i);
    assert.throws(() => appendEngineTurnFactInDatabase(db, {
      ...sampleFact(),
      id: 'fact-uppercase-secret-code',
      idempotencyKey: 'fact-uppercase-secret-code',
      payload: { errorCode: 'TOKEN:SUPERSECRET123', retryable: false },
    }), /payload/i);
    assert.throws(() => appendEngineTurnFactInDatabase(db, {
      ...sampleFact(),
      id: 'fact-unknown-type',
      idempotencyKey: 'fact-unknown-type',
      factType: 'unknown_fact' as never,
    }), /fact type/i);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM engine_turn_facts')?.count, 0);
  } finally {
    raw.close();
  }
});

test('每个 engine attempt 只有一个终态决策且读取按 engine 隔离', async () => {
  const { raw, db } = await createLegacyDatabase();
  try {
    ensureEngineTurnFactTables(db);
    appendEngineTurnFactInDatabase(db, sampleFact());
    const decision = {
      id: 'decision-1', sessionId: 'active', attemptId: 'attempt-1', engineId: 'codex' as const,
      externalTurnId: 'turn-1', outcome: 'failed' as const, reasonCode: 'PROVIDER_FAILED', factId: 'fact-1',
      decidedAt: 124, projectedAt: null,
    };
    assert.equal(insertEngineTerminalDecisionInDatabase(db, decision).inserted, true);
    assert.equal(insertEngineTerminalDecisionInDatabase(db, { ...decision, id: 'decision-2' }).inserted, false);
    const codebuddyFact = {
      ...sampleFact(), id: 'fact-codebuddy', engineId: 'codebuddy' as const,
      connectionId: 'connection-codebuddy', idempotencyKey: 'codebuddy:error:1',
    };
    appendEngineTurnFactInDatabase(db, codebuddyFact);
    assert.equal(insertEngineTerminalDecisionInDatabase(db, {
      ...decision, id: 'decision-codebuddy', engineId: 'codebuddy', factId: codebuddyFact.id,
    }).inserted, true);
    assert.equal(getEngineTerminalDecisionInDatabase(db, 'active', 'codex', 'attempt-1')?.id, 'decision-1');
    assert.equal(getEngineTerminalDecisionInDatabase(db, 'active', 'codebuddy', 'attempt-1')?.id, 'decision-codebuddy');
    db.run("DELETE FROM sessions WHERE id = 'active'");
    assert.equal(db.get('SELECT COUNT(*) AS count FROM engine_turn_facts')?.count, 0);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM engine_terminal_decisions')?.count, 0);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally {
    raw.close();
  }
});
