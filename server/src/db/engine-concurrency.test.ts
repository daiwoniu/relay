import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { DatabaseEngineConcurrencyRepository } from '../engine/concurrency/repository.js';
import {
  appendCapacityEventInDatabase,
  claimNextQueuedEntryInDatabase,
  ensureEngineConcurrencyTables,
  getCapacityWindowsInDatabase,
  getConcurrencySettingInDatabase,
  getCooldownInDatabase,
  getQueueEntryBySessionInDatabase,
  insertQueuedTurnInDatabase,
  listQueuedResourceKeysInDatabase,
  listQueueEntriesInDatabase,
  markLeaseRunningInDatabase,
  pruneCapacityEventsInDatabase,
  releaseAttemptCapacityInDatabase,
  upsertConcurrencySettingInDatabase,
  upsertCooldownInDatabase,
} from './engine-concurrency.js';

async function createDatabase() {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      engine TEXT NOT NULL,
      status TEXT NOT NULL,
      active_attempt_id TEXT,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );
    INSERT INTO users VALUES ('user-1');
    INSERT INTO users VALUES ('user-2');
    INSERT INTO projects VALUES ('project-1');
    INSERT INTO sessions VALUES ('session-1', 'project-1', 'codex', 'idle', NULL, 1, NULL);
    INSERT INTO sessions VALUES ('session-2', 'project-1', 'codex', 'idle', NULL, 1, NULL);
    INSERT INTO sessions VALUES ('session-3', 'project-1', 'codebuddy', 'idle', NULL, 1, NULL);
    INSERT INTO sessions VALUES ('session-4', 'project-1', 'codex', 'idle', NULL, 1, NULL);
    INSERT INTO messages VALUES ('message-1', 'session-1');
    INSERT INTO messages VALUES ('message-2', 'session-2');
    INSERT INTO messages VALUES ('message-3', 'session-3');
    INSERT INTO messages VALUES ('message-4', 'session-4');
  `);
  return { raw, db: new SQLiteDB(raw, ':memory:') };
}

function queueInput(sessionId: string, attemptId: string, messageId: string, createdAt: number, engineId = 'codex') {
  return {
    id: `queue-${attemptId}`,
    sessionId,
    attemptId,
    userMessageId: messageId,
    engineId: engineId as 'codex' | 'codebuddy',
    resourceKey: `${engineId}:default`,
    requestedByUserId: 'user-1',
    createdAt,
  };
}

test('并发治理表幂等创建且外键完整', async () => {
  const { raw, db } = await createDatabase();
  try {
    assert.equal(ensureEngineConcurrencyTables(db), true);
    assert.equal(ensureEngineConcurrencyTables(db), false);
    for (const table of [
      'engine_concurrency_settings',
      'engine_queue_entries',
      'engine_resource_leases',
      'engine_provider_cooldowns',
      'engine_capacity_events',
      'engine_queue_fairness',
    ]) {
      assert.equal(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])?.name, table);
    }
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally {
    raw.close();
  }
});

test('入队原子更新 session 并保持同资源严格 FIFO', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureEngineConcurrencyTables(db);
    insertQueuedTurnInDatabase(db, queueInput('session-2', 'attempt-2', 'message-2', 20));
    insertQueuedTurnInDatabase(db, queueInput('session-1', 'attempt-1', 'message-1', 10));
    assert.deepEqual(listQueueEntriesInDatabase(db, 'codex:default').map((entry) => entry.attemptId), ['attempt-1', 'attempt-2']);
    assert.equal(db.get("SELECT status FROM sessions WHERE id = 'session-1'")?.status, 'queued');
    assert.equal(db.get("SELECT active_attempt_id FROM sessions WHERE id = 'session-1'")?.active_attempt_id, 'attempt-1');
    assert.throws(() => insertQueuedTurnInDatabase(db, {
      ...queueInput('session-1', 'attempt-duplicate', 'message-1', 30),
      id: 'queue-duplicate',
    }));
    assert.equal(getQueueEntryBySessionInDatabase(db, 'session-1')?.attemptId, 'attempt-1');
  } finally {
    raw.close();
  }
});

test('启动恢复可列出全部有 queued 项的资源且去重', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureEngineConcurrencyTables(db);
    insertQueuedTurnInDatabase(db, queueInput('session-1', 'attempt-1', 'message-1', 10));
    insertQueuedTurnInDatabase(db, queueInput('session-2', 'attempt-2', 'message-2', 20));
    insertQueuedTurnInDatabase(db, queueInput('session-3', 'attempt-3', 'message-3', 30, 'codebuddy'));
    assert.deepEqual(listQueuedResourceKeysInDatabase(db), ['codebuddy:default', 'codex:default']);
    claimNextQueuedEntryInDatabase(db, {
      resourceKey: 'codebuddy:default', maxActiveTurns: 1, claimToken: 'claim-3', now: 40,
    });
    assert.deepEqual(listQueuedResourceKeysInDatabase(db), ['codex:default']);
  } finally {
    raw.close();
  }
});

test('claim 同事务领取队首、建立租约并遵守上限和冷却', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureEngineConcurrencyTables(db);
    insertQueuedTurnInDatabase(db, queueInput('session-1', 'attempt-1', 'message-1', 10));
    insertQueuedTurnInDatabase(db, queueInput('session-2', 'attempt-2', 'message-2', 20));

    const first = claimNextQueuedEntryInDatabase(db, {
      resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: 'claim-1', now: 100,
    });
    assert.equal(first?.queue.attemptId, 'attempt-1');
    assert.equal(first?.lease.state, 'claimed');
    assert.equal(db.get("SELECT status FROM sessions WHERE id = 'session-1'")?.status, 'pending');
    assert.equal(claimNextQueuedEntryInDatabase(db, {
      resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: 'claim-2', now: 100,
    }), null);

    assert.equal(markLeaseRunningInDatabase(db, 'attempt-1', 110)?.state, 'running');
    assert.equal(releaseAttemptCapacityInDatabase(db, 'attempt-1')?.resourceKey, 'codex:default');
    upsertCooldownInDatabase(db, {
      resourceKey: 'codex:default', consecutiveOverloads: 1, cooldownUntil: 200,
      probeAttemptId: null, lastOverloadAt: 120, lastSuccessAt: null, updatedAt: 120,
    });
    assert.equal(claimNextQueuedEntryInDatabase(db, {
      resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: 'claim-2', now: 150,
    }), null);
    assert.equal(getCooldownInDatabase(db, 'codex:default')?.cooldownUntil, 200);
    assert.equal(claimNextQueuedEntryInDatabase(db, {
      resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: 'claim-2', now: 200,
    })?.queue.attemptId, 'attempt-2');
  } finally {
    raw.close();
  }
});

test('claim 按账号轮转且账号内部保持 created_at 与 id 稳定 FIFO', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureEngineConcurrencyTables(db);
    insertQueuedTurnInDatabase(db, { ...queueInput('session-1', 'a-1', 'message-1', 10), id: 'queue-a-1' });
    insertQueuedTurnInDatabase(db, { ...queueInput('session-2', 'a-2', 'message-2', 10), id: 'queue-a-2' });
    insertQueuedTurnInDatabase(db, { ...queueInput('session-4', 'b-1', 'message-4', 20), requestedByUserId: 'user-2' });

    const claimed: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const claim = claimNextQueuedEntryInDatabase(db, {
        resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: `claim-${index}`, now: 100 + index,
      });
      assert.ok(claim);
      claimed.push(claim.queue.attemptId);
      releaseAttemptCapacityInDatabase(db, claim.queue.attemptId);
    }
    assert.deepEqual(claimed, ['a-1', 'b-1', 'a-2']);
  } finally {
    raw.close();
  }
});

test('账号轮转游标写入数据库，后续调度继续服务下一个账号', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureEngineConcurrencyTables(db);
    insertQueuedTurnInDatabase(db, queueInput('session-1', 'a-1', 'message-1', 10));
    insertQueuedTurnInDatabase(db, { ...queueInput('session-4', 'b-1', 'message-4', 20), requestedByUserId: 'user-2' });
    const first = claimNextQueuedEntryInDatabase(db, {
      resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: 'claim-a', now: 100,
    });
    assert.equal(first?.queue.attemptId, 'a-1');
    assert.equal(db.get("SELECT last_served_user_id FROM engine_queue_fairness WHERE resource_key = 'codex:default'")?.last_served_user_id, 'user-1');
    releaseAttemptCapacityInDatabase(db, 'a-1');

    assert.equal(claimNextQueuedEntryInDatabase(db, {
      resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: 'claim-b', now: 101,
    })?.queue.attemptId, 'b-1');
  } finally {
    raw.close();
  }
});

test('并发设置校验边界并按资源键隔离', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureEngineConcurrencyTables(db);
    assert.equal(getConcurrencySettingInDatabase(db, 'codex:default'), null);
    upsertConcurrencySettingInDatabase(db, {
      resourceKey: 'codex:default', engineId: 'codex', maxActiveTurns: 2,
      updatedByUserId: 'user-1', updatedAt: 100,
    });
    assert.equal(getConcurrencySettingInDatabase(db, 'codex:default')?.maxActiveTurns, 2);
    assert.throws(() => upsertConcurrencySettingInDatabase(db, {
      resourceKey: 'codebuddy:default', engineId: 'codebuddy', maxActiveTurns: 33,
      updatedByUserId: 'user-1', updatedAt: 100,
    }));
    assert.equal(getConcurrencySettingInDatabase(db, 'codebuddy:default'), null);
  } finally {
    raw.close();
  }
});

test('容量事件按滚动窗口统计并裁剪旧记录', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureEngineConcurrencyTables(db);
    const now = 10_000_000;
    for (const event of [
      { id: 'event-1', eventType: 'start_accepted' as const, occurredAt: now - 100 },
      { id: 'event-2', eventType: 'overload' as const, occurredAt: now - 200 },
      { id: 'event-3', eventType: 'request_retry' as const, occurredAt: now - 120_000 },
      { id: 'event-old', eventType: 'overload' as const, occurredAt: now - 4_000_000 },
    ]) appendCapacityEventInDatabase(db, { ...event, resourceKey: 'codex:default', attemptId: null });

    const windows = getCapacityWindowsInDatabase(db, 'codex:default', now, [5, 15, 60]);
    assert.deepEqual(windows.map((window) => [window.windowMinutes, window.totalCount, window.overloadCount]), [
      [5, 3, 1], [15, 3, 1], [60, 3, 1],
    ]);
    assert.equal(pruneCapacityEventsInDatabase(db, now - 3_600_000), 1);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM engine_capacity_events')?.count, 3);
  } finally {
    raw.close();
  }
});

test('容量事件仓储机会式清理 24 小时前记录', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureEngineConcurrencyTables(db);
    const now = 100_000_000;
    appendCapacityEventInDatabase(db, {
      id: 'event-old', resourceKey: 'codex:default', attemptId: null,
      eventType: 'overload', occurredAt: now - 24 * 60 * 60_000 - 1,
    });
    const repository = new DatabaseEngineConcurrencyRepository(db, () => 2, () => 'event-new');
    repository.appendCapacityEvent({
      resourceKey: 'codex:default', attemptId: 'attempt-new', eventType: 'start_accepted', occurredAt: now,
    });
    assert.equal(db.get("SELECT COUNT(*) AS count FROM engine_capacity_events WHERE id = 'event-old'")?.count, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM engine_capacity_events WHERE id = 'event-new'")?.count, 1);
  } finally {
    raw.close();
  }
});
