import { FIXED_WORKSPACE_PATH } from '../workspace-console/workspace-snapshot.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { claimNextQueuedEntryInDatabase, disableUserAndCancelQueuedTurnsInDatabase, ensureEngineConcurrencyTables } from '../db/engine-concurrency.js';
import { SQLiteDB } from '../db/index.js';
import { ensureWorkspaceConsoleLinksTable } from '../db/workspace-console-links-migration.js';
import { MAX_QUEUED_TURNS_PER_USER, TurnAdmissionError, TurnAdmissionService } from './turn-admission.js';

async function createHarness() {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-turn-admission-'));
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, disabled_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL, deleted_at INTEGER);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, engine TEXT NOT NULL, engine_bound INTEGER NOT NULL DEFAULT 1,
      selected_model_id TEXT, selected_reasoning_effort TEXT, selected_service_tier TEXT, engine_preferences_revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, active_attempt_id TEXT, updated_at INTEGER NOT NULL,
      message_revision INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, project_id TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, phase TEXT, items TEXT,
      metadata TEXT, created_at INTEGER NOT NULL, duration INTEGER, stopped INTEGER DEFAULT 0
    );
    INSERT INTO users VALUES ('user-1', NULL, 1);
    INSERT INTO projects VALUES ('project-1', '${FIXED_WORKSPACE_PATH.replaceAll("'", "''")}', NULL);
    INSERT INTO sessions VALUES ('session-1', 'codex', 1, NULL, NULL, NULL, 0, 'idle', NULL, 1, 0, NULL, 'project-1');
  `);
  const db = new SQLiteDB(raw, path.join(tempDir, 'relay.db'));
  ensureEngineConcurrencyTables(db);
  ensureWorkspaceConsoleLinksTable(db);
  return { raw, db, tempDir, service: new TurnAdmissionService(db, () => 100, () => 'queue-1') };
}

const resource = { resourceKey: 'codex:default', providerKey: null, label: 'Codex', defaultMaxActiveTurns: 2 };
const message = {
  id: 'message-1', session_id: 'session-1', turn_id: 'attempt-1', role: 'user' as const,
  content: '分析附件', phase: null, items: null,
  metadata: JSON.stringify({ attachments: [{ id: '11111111-1111-4111-8111-111111111111', kind: 'host_file', name: 'a.txt', path: 'C:\\work\\a.txt', size: 1 }] }),
};

test('准入原子保存消息、附件 metadata、attempt、queued 状态和 queue entry', async () => {
  const h = await createHarness();
  try {
    const result = h.service.enqueue({ sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1', message, resource });
    assert.equal(result.savedMessage.message.metadata, message.metadata);
    assert.equal(result.queue.userMessageId, 'message-1');
    assert.deepEqual(h.db.get("SELECT status, active_attempt_id FROM sessions WHERE id = 'session-1'"), { status: 'queued', active_attempt_id: 'attempt-1' });
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('first persisted user message writes exactly one explicit task link in the same admission', async () => {
  const h = await createHarness();
  try {
    h.service.enqueue({ sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1', message, resource,
      workspaceTaskLink: { taskId: 'task-a', workspacePath: FIXED_WORKSPACE_PATH } });
    assert.deepEqual(h.db.get('SELECT task_id, session_id, relation_source, confidence FROM workspace_console_links'),
      { task_id: 'task-a', session_id: 'session-1', relation_source: 'explicit', confidence: 'high' });
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM messages')?.count, 1);
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('disk persistence failure rolls back the user message, queue and task link together', async () => {
  const h = await createHarness();
  try {
    h.db.saveToFile = () => { throw new Error('disk failed'); };
    assert.throws(() => h.service.enqueue({ sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1', message, resource,
      workspaceTaskLink: { taskId: 'task-a', workspacePath: FIXED_WORKSPACE_PATH } }), /disk failed/);
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM messages')?.count, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM engine_queue_entries')?.count, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM workspace_console_links')?.count, 0);
  } finally { h.db.raw().close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('rejected first admission and nonfirst messages leave no task link', async () => {
  const h = await createHarness();
  const workspaceTaskLink = { taskId: 'task-a', workspacePath: FIXED_WORKSPACE_PATH };
  try {
    h.db.run("UPDATE sessions SET message_revision = 1 WHERE id = 'session-1'");
    assert.throws(() => h.service.enqueue({ sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1',
      message, resource, workspaceTaskLink }));
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM workspace_console_links')?.count, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM messages')?.count, 0);
    h.db.run("UPDATE sessions SET message_revision = 0 WHERE id = 'session-1'");
    assert.throws(() => h.service.enqueue({ sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1',
      message, resource, workspaceTaskLink: { ...workspaceTaskLink, workspacePath: 'D:\\other' } }));
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM workspace_console_links')?.count, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM messages')?.count, 0);
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('草稿首发在消息与队列事务内原子绑定引擎并保存偏好', async () => {
  const h = await createHarness();
  try {
    h.db.run("UPDATE sessions SET engine_bound = 0 WHERE id = 'session-1'");
    h.service.enqueue({
      sessionId: 'session-1', engineId: 'codebuddy', requestedByUserId: 'user-1',
      attemptId: 'attempt-1', message, resource: { ...resource, resourceKey: 'codebuddy:default' },
      bindEngine: true,
      enginePreferences: { modelId: 'hy3-x', reasoningEffort: 'high', serviceTier: 'priority', expectedRevision: 0 },
    });
    assert.deepEqual(h.db.get(
      "SELECT engine, engine_bound, selected_model_id, selected_reasoning_effort, selected_service_tier, engine_preferences_revision, status FROM sessions WHERE id = 'session-1'",
    ), {
      engine: 'codebuddy', engine_bound: 1, selected_model_id: 'hy3-x',
      selected_reasoning_effort: 'high', selected_service_tier: 'priority', engine_preferences_revision: 1, status: 'queued',
    });
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('草稿首发 revision 冲突时不留下绑定、消息或队列', async () => {
  const h = await createHarness();
  try {
    h.db.run("UPDATE sessions SET engine_bound = 0, engine_preferences_revision = 2 WHERE id = 'session-1'");
    assert.throws(() => h.service.enqueue({
      sessionId: 'session-1', engineId: 'codebuddy', requestedByUserId: 'user-1',
      attemptId: 'attempt-1', message, resource: { ...resource, resourceKey: 'codebuddy:default' },
      bindEngine: true,
      enginePreferences: { modelId: 'hy3-x', reasoningEffort: 'high', expectedRevision: 0 },
    }), (error) => error instanceof TurnAdmissionError
      && error.code === 'SESSION_ENGINE_PREFERENCES_CONFLICT');
    assert.deepEqual(h.db.get("SELECT engine_bound, status FROM sessions WHERE id = 'session-1'"), { engine_bound: 0, status: 'idle' });
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM messages')?.count, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM engine_queue_entries')?.count, 0);
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('已绑定会话发送时原子校验偏好 revision', async () => {
  const h = await createHarness();
  try {
    h.db.run("UPDATE sessions SET engine_preferences_revision = 1 WHERE id = 'session-1'");
    assert.throws(() => h.service.enqueue({
      sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1',
      attemptId: 'attempt-1', message, resource, enginePreferencesRevision: 0,
    }), (error) => error instanceof TurnAdmissionError
      && error.code === 'SESSION_ENGINE_PREFERENCES_CONFLICT');
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM messages')?.count, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM engine_queue_entries')?.count, 0);
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('同 session 第二次准入稳定拒绝且不保存第二条消息', async () => {
  const h = await createHarness();
  try {
    h.service.enqueue({ sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1', message, resource });
    assert.throws(() => h.service.enqueue({
      sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-2',
      message: { ...message, id: 'message-2', turn_id: 'attempt-2' }, resource,
    }), (error) => error instanceof TurnAdmissionError && error.code === 'SESSION_ALREADY_ACTIVE_OR_QUEUED');
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM messages')?.count, 1);
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('单账号 queued 达到固定上限后原子拒绝且不保存消息', async () => {
  const h = await createHarness();
  try {
    for (let index = 0; index < MAX_QUEUED_TURNS_PER_USER; index += 1) {
      h.db.run(
        `INSERT INTO sessions
         (id, engine, engine_bound, selected_model_id, selected_reasoning_effort, engine_preferences_revision,
          status, active_attempt_id, updated_at, message_revision, deleted_at)
         VALUES (?, 'codex', 1, NULL, NULL, 0, 'queued', ?, ?, 0, NULL)`,
        [`other-session-${index}`, `other-attempt-${index}`, index],
      );
      h.db.run(
        `INSERT INTO messages
         (id, session_id, turn_id, role, content, phase, items, metadata, created_at, duration, stopped)
         VALUES (?, ?, ?, 'user', '', NULL, NULL, NULL, ?, NULL, 0)`,
        [`other-message-${index}`, `other-session-${index}`, `other-attempt-${index}`, index],
      );
      h.db.run(
        `INSERT INTO engine_queue_entries
         (id, session_id, attempt_id, user_message_id, engine_id, resource_key, requested_by_user_id, state, claim_token, created_at, claimed_at)
         VALUES (?, ?, ?, ?, 'codex', 'codex:default', 'user-1', 'queued', NULL, ?, NULL)`,
        [`existing-${index}`, `other-session-${index}`, `other-attempt-${index}`, `other-message-${index}`, index],
      );
    }
    assert.throws(() => h.service.enqueue({
      sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1', message, resource,
      workspaceTaskLink: { taskId: 'task-a', workspacePath: FIXED_WORKSPACE_PATH },
    }), (error) => error instanceof TurnAdmissionError && error.code === 'USER_QUEUE_LIMIT_REACHED');
    assert.equal(h.db.get("SELECT COUNT(*) AS count FROM messages WHERE id = 'message-1'")?.count, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM workspace_console_links')?.count, 0);
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('queued 取消不调用引擎并原子保存 stopped assistant 后释放队列', async () => {
  const h = await createHarness();
  try {
    h.service.enqueue({ sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1', message, resource });
    const cancelled = h.service.cancelQueued('session-1');
    assert.equal(cancelled?.attemptId, 'attempt-1');
    assert.equal(cancelled?.savedMessage.message.role, 'assistant');
    assert.equal(cancelled?.savedMessage.message.stopped, 1);
    assert.equal(h.db.get('SELECT COUNT(*) AS count FROM engine_queue_entries')?.count, 0);
    assert.deepEqual(h.db.get("SELECT status, active_attempt_id FROM sessions WHERE id = 'session-1'"), { status: 'stopped', active_attempt_id: null });
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('停用账号取消全部 queued 并保存明确终态，不触碰已领取租约', async () => {
  const h = await createHarness();
  try {
    h.service.enqueue({ sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1', message, resource });
    const cancelled = disableUserAndCancelQueuedTurnsInDatabase(h.db, {
      userId: 'user-1', disabledAt: 200, idFactory: () => 'disabled-message-1',
    });
    assert.equal(cancelled.length, 1);
    assert.match(cancelled[0]!.savedMessage.message.content, /账号已停用/);
    assert.deepEqual(h.db.get("SELECT disabled_at, updated_at FROM users WHERE id = 'user-1'"), { disabled_at: 200, updated_at: 200 });
    assert.deepEqual(h.db.get("SELECT status, active_attempt_id FROM sessions WHERE id = 'session-1'"), { status: 'stopped', active_attempt_id: null });
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});

test('停用账号不强杀已经 claim 的任务与租约', async () => {
  const h = await createHarness();
  try {
    h.service.enqueue({ sessionId: 'session-1', engineId: 'codex', requestedByUserId: 'user-1', attemptId: 'attempt-1', message, resource });
    assert.ok(claimNextQueuedEntryInDatabase(h.db, {
      resourceKey: 'codex:default', maxActiveTurns: 1, claimToken: 'claim-1', now: 150,
    }));
    const cancelled = disableUserAndCancelQueuedTurnsInDatabase(h.db, {
      userId: 'user-1', disabledAt: 200, idFactory: () => 'unused',
    });
    assert.equal(cancelled.length, 0);
    assert.equal(h.db.get("SELECT COUNT(*) AS count FROM engine_resource_leases WHERE attempt_id = 'attempt-1'")?.count, 1);
    assert.deepEqual(h.db.get("SELECT status, active_attempt_id FROM sessions WHERE id = 'session-1'"), { status: 'pending', active_attempt_id: 'attempt-1' });
  } finally { h.raw.close(); fs.rmSync(h.tempDir, { recursive: true, force: true }); }
});
