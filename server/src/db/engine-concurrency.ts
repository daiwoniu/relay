import { randomUUID } from 'node:crypto';
import { feishuWorkItemIdFromTaskId } from '../workspace-console/task-reference.js';
import type { EngineId } from '../engine/types.js';
import type { SQLiteDB } from './index.js';
import { insertMessagesInOpenTransaction } from './queries.js';
import { insertWorkspaceLinkInOpenTransaction } from './queries-workspace-console.js';
import type { NewMessageRecord, SavedMessageRecord } from './query-types.js';

type ConcurrencyDatabase = Pick<SQLiteDB, 'all' | 'exec' | 'get' | 'run'>;

const RESOURCE_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,119}$/;
const ACTIVE_SESSION_STATUSES = new Set(['pending', 'processing', 'recovering', 'awaiting_action', 'stopping', 'queued']);
export const MAX_QUEUED_TURNS_PER_USER = 32;

export type EngineQueueState = 'queued' | 'claimed';
export type EngineLeaseState = 'claimed' | 'running';
export type EngineCapacityEventType =
  | 'start_claimed'
  | 'start_forwarded'
  | 'start_accepted'
  | 'start_failed'
  | 'overload'
  | 'request_retry'
  | 'completion_retry'
  | 'cooldown_started';

export interface EngineQueueEntry {
  id: string;
  sessionId: string;
  attemptId: string;
  userMessageId: string;
  engineId: EngineId;
  resourceKey: string;
  requestedByUserId: string;
  state: EngineQueueState;
  claimToken: string | null;
  createdAt: number;
  claimedAt: number | null;
}

export interface EngineResourceLease {
  attemptId: string;
  sessionId: string;
  engineId: EngineId;
  resourceKey: string;
  leaseToken: string;
  state: EngineLeaseState;
  acquiredAt: number;
  startedAt: number | null;
}

export interface EngineConcurrencySetting {
  resourceKey: string;
  engineId: EngineId;
  maxActiveTurns: number;
  updatedByUserId: string | null;
  updatedAt: number;
}

export interface EngineProviderCooldown {
  resourceKey: string;
  consecutiveOverloads: number;
  cooldownUntil: number | null;
  probeAttemptId: string | null;
  lastOverloadAt: number | null;
  lastSuccessAt: number | null;
  updatedAt: number;
}

export interface EngineCapacityWindow {
  windowMinutes: number;
  totalCount: number;
  overloadCount: number;
  requestRetryCount: number;
  completionRetryCount: number;
  cooldownCount: number;
  startAcceptedCount: number;
}

function tableExists(db: Pick<SQLiteDB, 'get'>, name: string): boolean {
  return Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

function validateResourceKey(resourceKey: string): void {
  if (!RESOURCE_KEY_PATTERN.test(resourceKey)) throw new Error('引擎并发资源键格式无效');
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error('引擎并发上限必须为 1 到 32 的整数');
  }
}

function transaction<T>(db: Pick<SQLiteDB, 'exec'>, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function parseEngineId(value: unknown): EngineId {
  if (value === 'codex' || value === 'codebuddy' || value === 'opencode' || value === 'zcode') return value;
  return 'codex';
}

function parseQueueEntry(row: Record<string, any>): EngineQueueEntry {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    attemptId: String(row.attempt_id),
    userMessageId: String(row.user_message_id),
    engineId: parseEngineId(row.engine_id),
    resourceKey: String(row.resource_key),
    requestedByUserId: String(row.requested_by_user_id),
    state: row.state === 'claimed' ? 'claimed' : 'queued',
    claimToken: row.claim_token == null ? null : String(row.claim_token),
    createdAt: Number(row.created_at),
    claimedAt: row.claimed_at == null ? null : Number(row.claimed_at),
  };
}

function parseLease(row: Record<string, any>): EngineResourceLease {
  return {
    attemptId: String(row.attempt_id),
    sessionId: String(row.session_id),
    engineId: parseEngineId(row.engine_id),
    resourceKey: String(row.resource_key),
    leaseToken: String(row.lease_token),
    state: row.state === 'running' ? 'running' : 'claimed',
    acquiredAt: Number(row.acquired_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
  };
}

function parseSetting(row: Record<string, any>): EngineConcurrencySetting {
  return {
    resourceKey: String(row.resource_key),
    engineId: parseEngineId(row.engine_id),
    maxActiveTurns: Number(row.max_active_turns),
    updatedByUserId: row.updated_by_user_id == null ? null : String(row.updated_by_user_id),
    updatedAt: Number(row.updated_at),
  };
}

function parseCooldown(row: Record<string, any>): EngineProviderCooldown {
  return {
    resourceKey: String(row.resource_key),
    consecutiveOverloads: Number(row.consecutive_overloads),
    cooldownUntil: row.cooldown_until == null ? null : Number(row.cooldown_until),
    probeAttemptId: row.probe_attempt_id == null ? null : String(row.probe_attempt_id),
    lastOverloadAt: row.last_overload_at == null ? null : Number(row.last_overload_at),
    lastSuccessAt: row.last_success_at == null ? null : Number(row.last_success_at),
    updatedAt: Number(row.updated_at),
  };
}

export function ensureEngineConcurrencyTables(db: ConcurrencyDatabase): boolean {
  if (!tableExists(db, 'sessions') || !tableExists(db, 'messages') || !tableExists(db, 'users')) return false;
  const names = [
    'engine_concurrency_settings',
    'engine_queue_entries',
    'engine_resource_leases',
    'engine_provider_cooldowns',
    'engine_capacity_events',
    'engine_queue_fairness',
  ];
  if (names.every((name) => tableExists(db, name))) return false;

  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS engine_concurrency_settings (
      resource_key TEXT PRIMARY KEY,
      engine_id TEXT NOT NULL CHECK(engine_id IN ('codex','codebuddy','opencode','zcode')),
      max_active_turns INTEGER NOT NULL CHECK(max_active_turns BETWEEN 1 AND 32),
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS engine_queue_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL UNIQUE,
      user_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      engine_id TEXT NOT NULL CHECK(engine_id IN ('codex','codebuddy','opencode','zcode')),
      resource_key TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('queued','claimed')),
      claim_token TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_engine_queue_fifo
      ON engine_queue_entries(resource_key, state, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_engine_queue_user_fifo
      ON engine_queue_entries(resource_key, requested_by_user_id, state, created_at, id);

    CREATE TABLE IF NOT EXISTS engine_queue_fairness (
      resource_key TEXT PRIMARY KEY,
      last_served_user_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS engine_resource_leases (
      attempt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      engine_id TEXT NOT NULL CHECK(engine_id IN ('codex','codebuddy','opencode','zcode')),
      resource_key TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('claimed','running')),
      acquired_at INTEGER NOT NULL,
      started_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_engine_leases_resource
      ON engine_resource_leases(resource_key, state, acquired_at);

    CREATE TABLE IF NOT EXISTS engine_provider_cooldowns (
      resource_key TEXT PRIMARY KEY,
      consecutive_overloads INTEGER NOT NULL DEFAULT 0,
      cooldown_until INTEGER,
      probe_attempt_id TEXT,
      last_overload_at INTEGER,
      last_success_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS engine_capacity_events (
      id TEXT PRIMARY KEY,
      resource_key TEXT NOT NULL,
      attempt_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'start_claimed','start_forwarded','start_accepted','start_failed','overload',
        'request_retry','completion_retry','cooldown_started'
      )),
      occurred_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_engine_capacity_events_resource_time
      ON engine_capacity_events(resource_key, occurred_at DESC);
  `));
  return true;
}

export function insertQueuedTurnInOpenTransaction(
  db: Pick<SQLiteDB, 'get' | 'run'>,
  input: Omit<EngineQueueEntry, 'state' | 'claimToken' | 'claimedAt'>,
): EngineQueueEntry {
  validateResourceKey(input.resourceKey);
  const session = db.get(
    'SELECT id, engine, status, deleted_at FROM sessions WHERE id = ?',
    [input.sessionId],
  );
  if (!session || session.deleted_at != null) throw new Error('排队会话不存在');
  if (session.engine !== input.engineId) throw new Error('排队引擎与会话不一致');
  if (ACTIVE_SESSION_STATUSES.has(String(session.status))) throw new Error('会话已有排队或活动回合');
  const message = db.get('SELECT session_id FROM messages WHERE id = ?', [input.userMessageId]);
  if (!message || message.session_id !== input.sessionId) throw new Error('排队用户消息不存在或不属于会话');
  const queuedByUser = Number(db.get(
    "SELECT COUNT(*) AS count FROM engine_queue_entries WHERE requested_by_user_id = ? AND state = 'queued'",
    [input.requestedByUserId],
  )?.count || 0);
  if (queuedByUser >= MAX_QUEUED_TURNS_PER_USER) throw new Error('账号待排队任务已达上限');

  db.run(
    `INSERT INTO engine_queue_entries
     (id, session_id, attempt_id, user_message_id, engine_id, resource_key,
      requested_by_user_id, state, claim_token, created_at, claimed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, NULL)`,
    [input.id, input.sessionId, input.attemptId, input.userMessageId, input.engineId,
      input.resourceKey, input.requestedByUserId, input.createdAt],
  );
  db.run(
    `UPDATE sessions SET status = 'queued', active_attempt_id = ?, updated_at = ? WHERE id = ?`,
    [input.attemptId, input.createdAt, input.sessionId],
  );
  const row = db.get('SELECT * FROM engine_queue_entries WHERE id = ?', [input.id]);
  if (!row) throw new Error('排队项写入后无法读取');
  return parseQueueEntry(row);
}

export function insertQueuedTurnInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'get' | 'run'>,
  input: Omit<EngineQueueEntry, 'state' | 'claimToken' | 'claimedAt'>,
): EngineQueueEntry {
  return transaction(db, () => insertQueuedTurnInOpenTransaction(db, input));
}

export function enqueueTurnWithMessageInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'get' | 'run'>,
  input: {
    message: NewMessageRecord;
    queue: Omit<EngineQueueEntry, 'state' | 'claimToken' | 'claimedAt' | 'userMessageId'>;
    now: number;
    expectedPreferencesRevision?: number;
    workspaceTaskLink?: { taskId: string; workspacePath: string };
    bind?: {
      engineId: EngineId;
      preferences?: { modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null; expectedRevision: number };
    };
  },
): { savedMessage: SavedMessageRecord; queue: EngineQueueEntry } {
  if (input.message.turn_id !== input.queue.attemptId) {
    throw new Error('排队消息与 attempt 不匹配');
  }
  if (input.message.session_id !== input.queue.sessionId || input.message.role !== 'user') {
    throw new Error('排队消息必须是同会话用户消息');
  }
  return transaction(db, () => {
    if (input.workspaceTaskLink) {
      const target = db.get(`SELECT p.path AS project_path FROM sessions s JOIN projects p ON p.id = s.project_id
        WHERE s.id = ? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND s.message_revision = 0
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)`, [input.queue.sessionId]);
      if (String(target?.project_path ?? '').toLowerCase() !== input.workspaceTaskLink.workspacePath.toLowerCase()) {
        throw new Error('任务关联只允许固定工作区新会话首发');
      }
    }
    const session = input.bind || input.expectedPreferencesRevision !== undefined
      ? db.get(
        'SELECT engine_bound, engine_preferences_revision FROM sessions WHERE id = ? AND deleted_at IS NULL',
        [input.queue.sessionId],
      )
      : undefined;
    if ((input.bind || input.expectedPreferencesRevision !== undefined) && !session) {
      throw new Error('排队会话不存在');
    }
    if (input.expectedPreferencesRevision !== undefined
      && Number(session!.engine_preferences_revision || 0) !== input.expectedPreferencesRevision) {
      throw new Error('会话模型偏好已在其他设备更新');
    }
    if (input.bind) {
      if (Number(session!.engine_bound) !== 0) throw new Error('会话引擎已绑定');
      const preferences = input.bind.preferences;
      if (preferences && Number(session!.engine_preferences_revision || 0) !== preferences.expectedRevision) {
        throw new Error('会话模型偏好已在其他设备更新');
      }
      db.run(
        `UPDATE sessions SET engine = ?, engine_bound = 1,
          selected_model_id = ?, selected_reasoning_effort = ?, selected_service_tier = ?,
          engine_preferences_revision = engine_preferences_revision + ?, updated_at = ?
         WHERE id = ? AND engine_bound = 0`,
        [
          input.bind.engineId,
          preferences?.modelId ?? null,
          preferences?.reasoningEffort ?? null,
          preferences?.serviceTier ?? null,
          preferences ? 1 : 0,
          input.now,
          input.queue.sessionId,
        ],
      );
    }
    const savedMessage = insertMessagesInOpenTransaction(db, [input.message], input.now)[0]!;
    const queue = insertQueuedTurnInOpenTransaction(db, {
      ...input.queue,
      userMessageId: input.message.id,
    });
    if (input.workspaceTaskLink) {
      const { taskId, workspacePath } = input.workspaceTaskLink;
      insertWorkspaceLinkInOpenTransaction(db, { id: randomUUID(), workspace_path: workspacePath, task_id: taskId,
        session_id: input.queue.sessionId, feishu_work_item_id: feishuWorkItemIdFromTaskId(taskId), run_id: null, relation_source: 'explicit', confidence: 'high',
        last_verified_at: input.now, created_at: input.now, updated_at: input.now });
    }
    return { savedMessage, queue };
  });
}

export function getQueueEntryBySessionInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  sessionId: string,
): EngineQueueEntry | null {
  const row = db.get('SELECT * FROM engine_queue_entries WHERE session_id = ?', [sessionId]);
  return row ? parseQueueEntry(row) : null;
}

function cancelQueuedTurnInOpenTransaction(
  db: Pick<SQLiteDB, 'get' | 'run'>,
  input: { sessionId: string; message: NewMessageRecord; now: number },
): { savedMessage: SavedMessageRecord; resourceKey: string; attemptId: string } | null {
  const row = db.get(
      "SELECT * FROM engine_queue_entries WHERE session_id = ? AND state = 'queued'",
      [input.sessionId],
    );
  if (!row) return null;
  const queue = parseQueueEntry(row);
  if (input.message.session_id !== input.sessionId
    || input.message.turn_id !== queue.attemptId
    || input.message.role !== 'assistant') {
    throw new Error('排队取消消息与 attempt 不匹配');
  }
  const savedMessage = insertMessagesInOpenTransaction(db, [input.message], input.now)[0]!;
  db.run('DELETE FROM engine_queue_entries WHERE id = ?', [queue.id]);
  db.run(
    `UPDATE sessions SET status = 'stopped', active_attempt_id = NULL, updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
     WHERE id = ?`,
    [input.now, input.now, input.sessionId],
  );
  return { savedMessage, resourceKey: queue.resourceKey, attemptId: queue.attemptId };
}

export function cancelQueuedTurnInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'get' | 'run'>,
  input: { sessionId: string; message: NewMessageRecord; now: number },
): { savedMessage: SavedMessageRecord; resourceKey: string; attemptId: string } | null {
  return transaction(db, () => cancelQueuedTurnInOpenTransaction(db, input));
}

export function disableUserAndCancelQueuedTurnsInDatabase(
  db: Pick<SQLiteDB, 'all' | 'exec' | 'get' | 'run'>,
  input: { userId: string; disabledAt: number; idFactory: () => string },
): Array<{ savedMessage: SavedMessageRecord; resourceKey: string; attemptId: string }> {
  return transaction(db, () => {
    const queued = db.all(
      "SELECT session_id, attempt_id FROM engine_queue_entries WHERE requested_by_user_id = ? AND state = 'queued' ORDER BY created_at, id",
      [input.userId],
    );
    const cancelled = queued.map((row) => cancelQueuedTurnInOpenTransaction(db, {
      sessionId: String(row.session_id),
      now: input.disabledAt,
      message: {
        id: input.idFactory(), session_id: String(row.session_id), turn_id: String(row.attempt_id), role: 'assistant',
        content: '账号已停用，尚未运行的排队任务已取消。', phase: null, items: null, metadata: null,
        duration: null, stopped: 1,
      },
    })).filter((result): result is NonNullable<typeof result> => result !== null);
    db.run('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?', [input.disabledAt, input.disabledAt, input.userId]);
    return cancelled;
  });
}

export function listQueueEntriesInDatabase(
  db: Pick<SQLiteDB, 'all'>,
  resourceKey: string,
): EngineQueueEntry[] {
  validateResourceKey(resourceKey);
  return db.all(
    `SELECT * FROM engine_queue_entries
     WHERE resource_key = ?
     ORDER BY created_at ASC, id ASC`,
    [resourceKey],
  ).map(parseQueueEntry);
}

export function listQueuedResourceKeysInDatabase(db: Pick<SQLiteDB, 'all'>): string[] {
  return db.all(
    `SELECT DISTINCT resource_key FROM engine_queue_entries
     WHERE state = 'queued'
     ORDER BY resource_key ASC`,
  ).map((row) => String(row.resource_key));
}

export function listClaimedQueueEntriesInDatabase(db: Pick<SQLiteDB, 'all'>): EngineQueueEntry[] {
  return db.all(
    `SELECT * FROM engine_queue_entries WHERE state = 'claimed' ORDER BY claimed_at ASC, id ASC`,
  ).map(parseQueueEntry);
}

export function countActiveLeasesInDatabase(db: Pick<SQLiteDB, 'get'>, resourceKey: string): number {
  validateResourceKey(resourceKey);
  return Number(db.get(
    'SELECT COUNT(*) AS count FROM engine_resource_leases WHERE resource_key = ?',
    [resourceKey],
  )?.count || 0);
}

export function countQueuedTurnsForUserInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  resourceKey: string,
  userId: string,
): number {
  validateResourceKey(resourceKey);
  return Number(db.get(
    "SELECT COUNT(*) AS count FROM engine_queue_entries WHERE resource_key = ? AND requested_by_user_id = ? AND state = 'queued'",
    [resourceKey, userId],
  )?.count || 0);
}

export function countActiveLeasesForUserInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  resourceKey: string,
  userId: string,
): number {
  validateResourceKey(resourceKey);
  return Number(db.get(
    `SELECT COUNT(*) AS count
     FROM engine_resource_leases leases
     JOIN engine_queue_entries queue ON queue.attempt_id = leases.attempt_id
     WHERE leases.resource_key = ? AND queue.requested_by_user_id = ?`,
    [resourceKey, userId],
  )?.count || 0);
}

export function claimNextQueuedEntryInDatabase(
  db: Pick<SQLiteDB, 'all' | 'exec' | 'get' | 'run'>,
  input: { resourceKey: string; maxActiveTurns: number; claimToken: string; now: number },
): { queue: EngineQueueEntry; lease: EngineResourceLease } | null {
  validateResourceKey(input.resourceKey);
  validateLimit(input.maxActiveTurns);
  if (!input.claimToken) throw new Error('claim token 不能为空');
  return transaction(db, () => {
    const cooldown = getCooldownInDatabase(db, input.resourceKey);
    if (cooldown?.cooldownUntil != null && cooldown.cooldownUntil > input.now) return null;
    if (countActiveLeasesInDatabase(db, input.resourceKey) >= input.maxActiveTurns) return null;
    const lastServedUserId = db.get(
      'SELECT last_served_user_id FROM engine_queue_fairness WHERE resource_key = ?',
      [input.resourceKey],
    )?.last_served_user_id;
    const candidates = db.all(
      `SELECT requested_by_user_id, MIN(created_at) AS first_created_at
       FROM engine_queue_entries
       WHERE resource_key = ? AND state = 'queued'
       GROUP BY requested_by_user_id`,
      [input.resourceKey],
    );
    if (candidates.length === 0) return null;
    const orderedCandidates = candidates.sort((left, right) => {
      if (lastServedUserId == null) {
        const timeOrder = Number(left.first_created_at) - Number(right.first_created_at);
        if (timeOrder !== 0) return timeOrder;
      }
      const leftUserId = String(left.requested_by_user_id);
      const rightUserId = String(right.requested_by_user_id);
      return leftUserId < rightUserId ? -1 : leftUserId > rightUserId ? 1 : 0;
    });
    const nextUser = lastServedUserId == null
      ? orderedCandidates[0]
      : orderedCandidates.find((candidate) => String(candidate.requested_by_user_id) > String(lastServedUserId))
        ?? orderedCandidates[0];
    const row = db.get(
      `SELECT * FROM engine_queue_entries
       WHERE resource_key = ? AND requested_by_user_id = ? AND state = 'queued'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [input.resourceKey, String(nextUser!.requested_by_user_id)],
    );
    if (!row) return null;
    const queue = parseQueueEntry(row);
    db.run(
      `UPDATE engine_queue_entries
       SET state = 'claimed', claim_token = ?, claimed_at = ?
       WHERE id = ? AND state = 'queued'`,
      [input.claimToken, input.now, queue.id],
    );
    if (Number(db.get('SELECT changes() AS count')?.count || 0) !== 1) return null;
    db.run(
      `INSERT INTO engine_queue_fairness (resource_key, last_served_user_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(resource_key) DO UPDATE SET
         last_served_user_id = excluded.last_served_user_id,
         updated_at = excluded.updated_at`,
      [input.resourceKey, queue.requestedByUserId, input.now],
    );
    db.run(
      `INSERT INTO engine_resource_leases
       (attempt_id, session_id, engine_id, resource_key, lease_token, state, acquired_at, started_at)
       VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL)`,
      [queue.attemptId, queue.sessionId, queue.engineId, queue.resourceKey, input.claimToken, input.now],
    );
    db.run(
      `UPDATE sessions SET status = 'pending', active_attempt_id = ?, updated_at = ? WHERE id = ?`,
      [queue.attemptId, input.now, queue.sessionId],
    );
    const claimedRow = db.get('SELECT * FROM engine_queue_entries WHERE id = ?', [queue.id]);
    const leaseRow = db.get('SELECT * FROM engine_resource_leases WHERE attempt_id = ?', [queue.attemptId]);
    if (!claimedRow || !leaseRow) throw new Error('队列 claim 提交前无法读取权威状态');
    return { queue: parseQueueEntry(claimedRow), lease: parseLease(leaseRow) };
  });
}

export function markLeaseRunningInDatabase(
  db: Pick<SQLiteDB, 'get' | 'run'>,
  attemptId: string,
  startedAt: number,
): EngineResourceLease | null {
  db.run(
    `UPDATE engine_resource_leases
     SET state = 'running', started_at = COALESCE(started_at, ?)
     WHERE attempt_id = ?`,
    [startedAt, attemptId],
  );
  const row = db.get('SELECT * FROM engine_resource_leases WHERE attempt_id = ?', [attemptId]);
  return row ? parseLease(row) : null;
}

export function releaseAttemptCapacityInOpenTransaction(
  db: Pick<SQLiteDB, 'get' | 'run'>,
  attemptId: string,
): { resourceKey: string; sessionId: string } | null {
  const row = db.get('SELECT resource_key, session_id FROM engine_resource_leases WHERE attempt_id = ?', [attemptId]);
  const queueRow = db.get('SELECT resource_key, session_id FROM engine_queue_entries WHERE attempt_id = ?', [attemptId]);
  const source = row || queueRow;
  if (!source) return null;
  db.run('DELETE FROM engine_resource_leases WHERE attempt_id = ?', [attemptId]);
  db.run('DELETE FROM engine_queue_entries WHERE attempt_id = ?', [attemptId]);
  return { resourceKey: String(source.resource_key), sessionId: String(source.session_id) };
}

export function releaseAttemptCapacityInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'get' | 'run'>,
  attemptId: string,
): { resourceKey: string; sessionId: string } | null {
  return transaction(db, () => releaseAttemptCapacityInOpenTransaction(db, attemptId));
}

export function getConcurrencySettingInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  resourceKey: string,
): EngineConcurrencySetting | null {
  validateResourceKey(resourceKey);
  const row = db.get('SELECT * FROM engine_concurrency_settings WHERE resource_key = ?', [resourceKey]);
  return row ? parseSetting(row) : null;
}

export function upsertConcurrencySettingInDatabase(
  db: Pick<SQLiteDB, 'get' | 'run'>,
  input: EngineConcurrencySetting,
): EngineConcurrencySetting {
  validateResourceKey(input.resourceKey);
  validateLimit(input.maxActiveTurns);
  db.run(
    `INSERT INTO engine_concurrency_settings
     (resource_key, engine_id, max_active_turns, updated_by_user_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(resource_key) DO UPDATE SET
       engine_id = excluded.engine_id,
       max_active_turns = excluded.max_active_turns,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
    [input.resourceKey, input.engineId, input.maxActiveTurns, input.updatedByUserId, input.updatedAt],
  );
  const row = db.get('SELECT * FROM engine_concurrency_settings WHERE resource_key = ?', [input.resourceKey]);
  if (!row) throw new Error('并发设置写入后无法读取');
  return parseSetting(row);
}

export function getCooldownInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  resourceKey: string,
): EngineProviderCooldown | null {
  validateResourceKey(resourceKey);
  const row = db.get('SELECT * FROM engine_provider_cooldowns WHERE resource_key = ?', [resourceKey]);
  return row ? parseCooldown(row) : null;
}

export function upsertCooldownInDatabase(
  db: Pick<SQLiteDB, 'get' | 'run'>,
  input: EngineProviderCooldown,
): EngineProviderCooldown {
  validateResourceKey(input.resourceKey);
  if (!Number.isSafeInteger(input.consecutiveOverloads) || input.consecutiveOverloads < 0) {
    throw new Error('连续过载次数格式无效');
  }
  db.run(
    `INSERT INTO engine_provider_cooldowns
     (resource_key, consecutive_overloads, cooldown_until, probe_attempt_id,
      last_overload_at, last_success_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(resource_key) DO UPDATE SET
       consecutive_overloads = excluded.consecutive_overloads,
       cooldown_until = excluded.cooldown_until,
       probe_attempt_id = excluded.probe_attempt_id,
       last_overload_at = excluded.last_overload_at,
       last_success_at = excluded.last_success_at,
       updated_at = excluded.updated_at`,
    [input.resourceKey, input.consecutiveOverloads, input.cooldownUntil, input.probeAttemptId,
      input.lastOverloadAt, input.lastSuccessAt, input.updatedAt],
  );
  const row = db.get('SELECT * FROM engine_provider_cooldowns WHERE resource_key = ?', [input.resourceKey]);
  if (!row) throw new Error('Provider 冷却写入后无法读取');
  return parseCooldown(row);
}

export function appendCapacityEventInDatabase(
  db: Pick<SQLiteDB, 'run'>,
  input: { id: string; resourceKey: string; attemptId: string | null; eventType: EngineCapacityEventType; occurredAt: number },
): void {
  validateResourceKey(input.resourceKey);
  db.run(
    `INSERT OR IGNORE INTO engine_capacity_events
     (id, resource_key, attempt_id, event_type, occurred_at) VALUES (?, ?, ?, ?, ?)`,
    [input.id, input.resourceKey, input.attemptId, input.eventType, input.occurredAt],
  );
}

export function getCapacityWindowsInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  resourceKey: string,
  now: number,
  windows: number[],
): EngineCapacityWindow[] {
  validateResourceKey(resourceKey);
  return windows.map((windowMinutes) => {
    if (!Number.isSafeInteger(windowMinutes) || windowMinutes <= 0) throw new Error('容量统计窗口格式无效');
    const row = db.get(
      `SELECT COUNT(*) AS total_count,
              SUM(CASE WHEN event_type = 'overload' THEN 1 ELSE 0 END) AS overload_count,
              SUM(CASE WHEN event_type = 'request_retry' THEN 1 ELSE 0 END) AS request_retry_count,
              SUM(CASE WHEN event_type = 'completion_retry' THEN 1 ELSE 0 END) AS completion_retry_count,
              SUM(CASE WHEN event_type = 'cooldown_started' THEN 1 ELSE 0 END) AS cooldown_count,
              SUM(CASE WHEN event_type = 'start_accepted' THEN 1 ELSE 0 END) AS start_accepted_count
       FROM engine_capacity_events
       WHERE resource_key = ? AND occurred_at >= ?`,
      [resourceKey, now - windowMinutes * 60_000],
    ) || {};
    return {
      windowMinutes,
      totalCount: Number(row.total_count || 0),
      overloadCount: Number(row.overload_count || 0),
      requestRetryCount: Number(row.request_retry_count || 0),
      completionRetryCount: Number(row.completion_retry_count || 0),
      cooldownCount: Number(row.cooldown_count || 0),
      startAcceptedCount: Number(row.start_accepted_count || 0),
    };
  });
}

export function pruneCapacityEventsInDatabase(db: Pick<SQLiteDB, 'get' | 'run'>, before: number): number {
  db.run('DELETE FROM engine_capacity_events WHERE occurred_at < ?', [before]);
  return Number(db.get('SELECT changes() AS count')?.count || 0);
}
