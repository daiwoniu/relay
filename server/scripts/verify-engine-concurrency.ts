import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import {
  cancelQueuedTurnInDatabase,
  ensureEngineConcurrencyTables,
  getCooldownInDatabase,
  getQueueEntryBySessionInDatabase,
  insertQueuedTurnInDatabase,
  listQueuedResourceKeysInDatabase,
  listQueueEntriesInDatabase,
  markLeaseRunningInDatabase,
  releaseAttemptCapacityInDatabase,
  upsertConcurrencySettingInDatabase,
  upsertCooldownInDatabase,
} from '../src/db/engine-concurrency.js';
import { SQLiteDB } from '../src/db/index.js';
import type { EngineAdapter } from '../src/engine/adapter.js';
import { DatabaseEngineConcurrencyRepository, type QueueClaim } from '../src/engine/concurrency/repository.js';
import { decideClaimedRecovery, resumeQueuedResources } from '../src/engine/concurrency/recovery.js';
import { ProviderTurnScheduler } from '../src/engine/concurrency/scheduler.js';
import { EngineRegistry } from '../src/engine/registry.js';
import type { EngineId } from '../src/engine/types.js';
import { createEngineConcurrencyApi } from '../src/services/engine-concurrency-api.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(serverRoot, '..');

type SessionSeed = { id: string; engineId: EngineId };
let schedulerSequence = 0;

export function assertIsolatedConcurrencyPaths(input: { tempRoot: string; dbPath: string; projectRoot?: string }): void {
  const root = path.resolve(input.tempRoot);
  const project = path.resolve(input.projectRoot ?? projectRoot);
  const dbPath = path.resolve(input.dbPath);
  assert.notEqual(dbPath, project, '并发验收数据库不得指向正式项目根目录');
  assert.equal(dbPath.startsWith(`${root}${path.sep}`), true, `并发验收数据库必须位于临时目录：${dbPath}`);
}

function fakeAdapter(engineId: EngineId, defaultMaxActiveTurns: number): EngineAdapter {
  const label = engineId === 'codex' ? 'Codex' : 'CodeBuddy';
  return {
    id: engineId,
    concurrency: {
      resolveResource: () => ({
        resourceKey: `${engineId}:default`, providerKey: null, label, defaultMaxActiveTurns,
      }),
    },
  } as unknown as EngineAdapter;
}

async function createDatabase(dbPath: string, sessions: SessionSeed[]): Promise<{ db: SQLiteDB; close(): void }> {
  const SQL = await initSqlJs({ locateFile: () => path.resolve(serverRoot, 'node_modules/sql.js/dist/sql-wasm.wasm') });
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
      deleted_at INTEGER,
      message_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      phase TEXT,
      items TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      duration INTEGER,
      stopped INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users VALUES ('acceptance-user');
    INSERT INTO projects VALUES ('acceptance-project');
  `);
  const db = new SQLiteDB(raw, dbPath);
  for (const [index, session] of sessions.entries()) {
    db.run('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, ?, NULL, 1)', [
      session.id, 'acceptance-project', session.engineId, 'idle', index + 1,
    ]);
    db.run('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, 0)', [
      `message-${session.id}`, session.id, `attempt-${session.id}`, 'user', session.id, index + 1,
    ]);
  }
  ensureEngineConcurrencyTables(db);
  return { db, close: () => raw.close() };
}

async function reopenDatabase(dbPath: string): Promise<{ db: SQLiteDB; close(): void }> {
  const SQL = await initSqlJs({ locateFile: () => path.resolve(serverRoot, 'node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database(await readFile(dbPath));
  return { db: new SQLiteDB(raw, dbPath), close: () => raw.close() };
}

function enqueue(db: SQLiteDB, sessionId: string, engineId: EngineId, createdAt: number): void {
  insertQueuedTurnInDatabase(db, {
    id: `queue-${sessionId}`,
    sessionId,
    attemptId: `attempt-${sessionId}`,
    userMessageId: `message-${sessionId}`,
    engineId,
    resourceKey: `${engineId}:default`,
    requestedByUserId: 'acceptance-user',
    createdAt,
  });
}

function createScheduler(db: SQLiteDB, input: { now: () => number; started: string[]; wakes?: Array<{ resourceKey: string; delayMs: number }> }) {
  const schedulerId = ++schedulerSequence;
  const repository = new DatabaseEngineConcurrencyRepository(
    db,
    (resourceKey) => resourceKey === 'codex:default' ? 2 : 4,
    (() => { let id = 0; return () => `event-${++id}`; })(),
  );
  let claimId = 0;
  const scheduler = new ProviderTurnScheduler({
    repository,
    now: input.now,
    idFactory: () => `claim-${schedulerId}-${++claimId}`,
    scheduleWake: (resourceKey, delayMs) => input.wakes?.push({ resourceKey, delayMs }),
    dispatcher: {
      start: (claim: QueueClaim) => { input.started.push(claim.queue.attemptId); },
      fail: () => undefined,
    },
  });
  return { repository, scheduler };
}

export async function runEngineConcurrencyVerification() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-engine-concurrency-'));
  const dbPath = path.join(tempRoot, 'relay.db');
  assertIsolatedConcurrencyPaths({ tempRoot, dbPath });
  const sessions: SessionSeed[] = [
    ...['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, engineId: 'codex' as const })),
    ...['b1', 'b2', 'b3'].map((id) => ({ id, engineId: 'codebuddy' as const })),
  ];
  let opened: Awaited<ReturnType<typeof createDatabase>> | null = null;
  try {
    opened = await createDatabase(dbPath, sessions);
    const { db } = opened;
    const registry = new EngineRegistry([fakeAdapter('codex', 2), fakeAdapter('codebuddy', 4)]);
    const started: string[] = [];
    let now = 1_000;
    const { scheduler } = createScheduler(db, { now: () => now, started });
    const api = createEngineConcurrencyApi({ registry, getDb: () => db, broadcast: () => undefined, drain: (key) => scheduler.drain(key), now: () => now });

    assert.deepEqual(api.listSnapshots().map((item) => [item.resourceKey, item.maxActiveTurns]), [
      ['codex:default', 2], ['codebuddy:default', 4],
    ]);

    enqueue(db, 'c1', 'codex', 10);
    enqueue(db, 'c2', 'codex', 20);
    enqueue(db, 'c3', 'codex', 30);
    enqueue(db, 'c4', 'codex', 40);
    enqueue(db, 'b1', 'codebuddy', 15);
    await Promise.all([scheduler.drain('codex:default'), scheduler.drain('codebuddy:default')]);
    assert.deepEqual(started.filter((attemptId) => attemptId.startsWith('attempt-c')), ['attempt-c1', 'attempt-c2']);
    assert.deepEqual(started.filter((attemptId) => attemptId.startsWith('attempt-b')), ['attempt-b1']);
    assert.equal(getQueueEntryBySessionInDatabase(db, 'c3')?.state, 'queued');
    assert.equal(getQueueEntryBySessionInDatabase(db, 'b1')?.state, 'claimed');

    const firstSnapshot = api.listSnapshots();
    const secondSnapshot = api.listSnapshots();
    assert.deepEqual(secondSnapshot, firstSnapshot);
    assert.equal(firstSnapshot.find((item) => item.resourceKey === 'codex:default')?.queuedTurns, 2);

    const cancelled = cancelQueuedTurnInDatabase(db, {
      sessionId: 'c4', now: 50,
      message: { id: 'cancel-c4', session_id: 'c4', turn_id: 'attempt-c4', role: 'assistant', content: '', stopped: 1 },
    });
    assert.equal(cancelled?.attemptId, 'attempt-c4');
    assert.equal(getQueueEntryBySessionInDatabase(db, 'c4'), null);

    releaseAttemptCapacityInDatabase(db, 'attempt-c1');
    await scheduler.drain('codex:default');
    assert.deepEqual(started.slice(-1), ['attempt-c3']);

    enqueue(db, 'c5', 'codex', 60);
    upsertConcurrencySettingInDatabase(db, { resourceKey: 'codex:default', engineId: 'codex', maxActiveTurns: 1, updatedByUserId: 'acceptance-user', updatedAt: 61 });
    await scheduler.drain('codex:default');
    assert.equal(getQueueEntryBySessionInDatabase(db, 'c5')?.state, 'queued');
    upsertConcurrencySettingInDatabase(db, { resourceKey: 'codex:default', engineId: 'codex', maxActiveTurns: 3, updatedByUserId: 'acceptance-user', updatedAt: 62 });
    await scheduler.drain('codex:default');
    assert.equal(getQueueEntryBySessionInDatabase(db, 'c5')?.state, 'claimed');

    releaseAttemptCapacityInDatabase(db, 'attempt-c2');
    releaseAttemptCapacityInDatabase(db, 'attempt-c3');
    releaseAttemptCapacityInDatabase(db, 'attempt-c5');
    db.run("UPDATE sessions SET status = 'idle', active_attempt_id = NULL WHERE id IN ('c1', 'c2', 'c3', 'c5')");
    db.run('DELETE FROM messages WHERE id = ?', ['message-c1']);
    db.run("INSERT INTO messages VALUES ('message-c1-probe', 'c1', 'attempt-c1-probe', 'user', 'probe-1', NULL, NULL, NULL, 70, NULL, 0)");
    db.run('DELETE FROM messages WHERE id = ?', ['message-c2']);
    db.run("INSERT INTO messages VALUES ('message-c2-probe', 'c2', 'attempt-c2-probe', 'user', 'probe-2', NULL, NULL, NULL, 71, NULL, 0)");
    insertQueuedTurnInDatabase(db, { id: 'queue-c1-probe', sessionId: 'c1', attemptId: 'attempt-c1-probe', userMessageId: 'message-c1-probe', engineId: 'codex', resourceKey: 'codex:default', requestedByUserId: 'acceptance-user', createdAt: 70 });
    insertQueuedTurnInDatabase(db, { id: 'queue-c2-probe', sessionId: 'c2', attemptId: 'attempt-c2-probe', userMessageId: 'message-c2-probe', engineId: 'codex', resourceKey: 'codex:default', requestedByUserId: 'acceptance-user', createdAt: 71 });
    upsertConcurrencySettingInDatabase(db, { resourceKey: 'codex:default', engineId: 'codex', maxActiveTurns: 2, updatedByUserId: 'acceptance-user', updatedAt: 72 });
    const probeStarted: string[] = [];
    const wakes: Array<{ resourceKey: string; delayMs: number }> = [];
    const probeRuntime = createScheduler(db, { now: () => now, started: probeStarted, wakes });
    await probeRuntime.scheduler.onProviderOverload('codex:default', 'attempt-overload', null);
    await probeRuntime.scheduler.drain('codex:default');
    assert.equal(probeStarted.length, 0);
    assert.deepEqual(wakes, [{ resourceKey: 'codex:default', delayMs: 30_000 }]);
    now += 30_000;
    await probeRuntime.scheduler.drain('codex:default');
    assert.deepEqual(probeStarted, ['attempt-c1-probe']);
    assert.equal(getQueueEntryBySessionInDatabase(db, 'c2')?.state, 'queued');
    await probeRuntime.scheduler.onStartAccepted('codex:default', 'attempt-c1-probe');
    assert.deepEqual(probeStarted, ['attempt-c1-probe', 'attempt-c2-probe']);
    assert.equal(getCooldownInDatabase(db, 'codex:default')?.cooldownUntil, null);

    markLeaseRunningInDatabase(db, 'attempt-c1-probe', now + 1);
    upsertCooldownInDatabase(db, { resourceKey: 'codebuddy:default', consecutiveOverloads: 1, cooldownUntil: now + 60_000, probeAttemptId: null, lastOverloadAt: now, lastSuccessAt: null, updatedAt: now });
    insertQueuedTurnInDatabase(db, {
      id: 'queue-b3', sessionId: 'b3', attemptId: 'attempt-b3', userMessageId: 'message-b3',
      engineId: 'codebuddy', resourceKey: 'codebuddy:secondary',
      requestedByUserId: 'acceptance-user', createdAt: now + 2,
    });
    db.saveToFile();
    opened.close();
    opened = await reopenDatabase(dbPath);
    assert.equal(getQueueEntryBySessionInDatabase(opened.db, 'c1')?.state, 'claimed');
    assert.equal(opened.db.get("SELECT state FROM engine_resource_leases WHERE attempt_id = 'attempt-c1-probe'")?.state, 'running');
    assert.equal(getCooldownInDatabase(opened.db, 'codebuddy:default')?.cooldownUntil, now + 60_000);
    const resumedAfterRestart: string[] = [];
    const resumedRuntime = createScheduler(opened.db, { now: () => now, started: resumedAfterRestart });
    await resumeQueuedResources(
      listQueuedResourceKeysInDatabase(opened.db),
      (resourceKey) => resumedRuntime.scheduler.drain(resourceKey),
    );
    assert.deepEqual(resumedAfterRestart, ['attempt-b3']);
    assert.equal(decideClaimedRecovery({ engineId: 'codebuddy', hasTurnStartedFact: false, hasTerminalFact: false, hasExternalSession: false, restartMode: 'interrupt' }), 'interrupt_unrecoverable');
    releaseAttemptCapacityInDatabase(opened.db, 'attempt-c1-probe');
    opened.db.saveToFile();
    assert.equal(getQueueEntryBySessionInDatabase(opened.db, 'c1'), null);
    assert.equal(listQueueEntriesInDatabase(opened.db, 'codex:default').some((entry) => entry.attemptId === 'attempt-c1-probe'), false);

    return {
      ok: true,
      defaults: { codex: 2, codebuddy: 4 },
      scenarios: {
        fifo2Plus1: true,
        resourceIsolation: true,
        queuedCancellation: true,
        limitAdjustment: true,
        terminalBackfill: true,
        overloadCooldown: true,
        singleProbeRecovery: true,
        restartPersistenceAndAutoResume: true,
        authoritativeSnapshots: true,
        claimedAtMostOnce: true,
      },
      tempRoot,
    };
  } finally {
    opened?.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runEngineConcurrencyVerification();
  console.log(JSON.stringify({ ...result, tempRoot: '已清理' }, null, 2));
}
