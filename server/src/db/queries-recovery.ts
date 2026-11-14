import { EngineIdSchema, TokenUsageDtoSchema, type EngineId, type TokenUsageDto } from '../contracts/index.js';
import { getDB, type SQLiteDB } from './index.js';

export interface RecoverableSessionRecord {
  id: string;
  engine: EngineId;
  previousStatus: 'pending' | 'processing' | 'awaiting_action' | 'stopping';
  externalSessionId: string | null;
  turnId: string | null;
  attemptId: string;
  startedAt: number | null;
  resourceKey?: string;
  leaseToken?: string;
  tokenUsage?: TokenUsageDto;
  latestTokenUsage?: TokenUsageDto;
  requestedByUserId?: string;
}

function parseRecoverableEngineId(value: unknown): EngineId {
  const parsed = EngineIdSchema.safeParse(value);
  if (!parsed.success) throw new Error(`恢复会话包含不受支持的引擎 ID：${String(value)}`);
  return parsed.data;
}

export function prepareRecoverableSessions(): RecoverableSessionRecord[] {
  return prepareRecoverableSessionsInDatabase(getDB());
}

export function prepareRecoverableSessionsInDatabase(
  db: Pick<SQLiteDB, 'all' | 'run' | 'saveToFile'>,
): RecoverableSessionRecord[] {
  const hasActiveAttemptColumn = db.all('PRAGMA table_info(sessions)')
    .some((column) => column.name === 'active_attempt_id');
  const activeAttemptSelection = hasActiveAttemptColumn
    ? 's.active_attempt_id'
    : 'NULL AS active_attempt_id';
  const hasLeaseTable = db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engine_resource_leases'",
  ).length > 0;
  const hasQueueTable = db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engine_queue_entries'",
  ).length > 0;
  const leaseSelection = hasActiveAttemptColumn && hasLeaseTable
    ? 'l.resource_key, l.lease_token'
    : 'NULL AS resource_key, NULL AS lease_token';
  const leaseJoin = hasActiveAttemptColumn && hasLeaseTable
    ? 'LEFT JOIN engine_resource_leases l ON l.attempt_id = s.active_attempt_id'
    : '';
  const requesterSelection = hasActiveAttemptColumn && hasQueueTable
    ? 'q.requested_by_user_id'
    : 'NULL AS requested_by_user_id';
  const queueJoin = hasActiveAttemptColumn && hasQueueTable
    ? 'LEFT JOIN engine_queue_entries q ON q.attempt_id = s.active_attempt_id'
    : '';
  const recoverable = db.all(
    `SELECT s.id, s.engine, s.status, s.recovery_previous_status, s.engine_session_id, s.active_turn_id,
            ${activeAttemptSelection}, s.active_turn_started_at, s.active_turn_usage, s.token_usage,
            ${leaseSelection}, ${requesterSelection}
     FROM sessions s
     ${leaseJoin}
     ${queueJoin}
     WHERE s.deleted_at IS NULL AND s.status IN ('pending', 'processing', 'awaiting_action', 'stopping', 'recovering')`,
  ).map((session) => {
    let tokenUsage: TokenUsageDto | undefined;
    let latestTokenUsage: TokenUsageDto | undefined;
    try {
      const parsed = TokenUsageDtoSchema.safeParse(JSON.parse(String(session.active_turn_usage || 'null')));
      if (parsed.success) tokenUsage = parsed.data;
    } catch { tokenUsage = undefined; }
    try {
      const parsed = TokenUsageDtoSchema.safeParse(JSON.parse(String(session.token_usage || 'null')));
      if (parsed.success) latestTokenUsage = parsed.data;
    } catch { latestTokenUsage = undefined; }
    return {
      id: String(session.id),
      engine: parseRecoverableEngineId(session.engine),
      previousStatus: (
        session.status === 'recovering'
          ? (session.recovery_previous_status || 'processing')
          : session.status
      ) as RecoverableSessionRecord['previousStatus'],
      externalSessionId: typeof session.engine_session_id === 'string' && session.engine_session_id ? session.engine_session_id : null,
      turnId: typeof session.active_turn_id === 'string' && session.active_turn_id ? session.active_turn_id : null,
      attemptId: typeof session.active_attempt_id === 'string' && session.active_attempt_id
        ? session.active_attempt_id
        : `legacy:${String(session.id)}:${String(session.active_turn_id || 'none')}:${String(session.active_turn_started_at || 'none')}`,
      startedAt: typeof session.active_turn_started_at === 'number' ? session.active_turn_started_at : null,
      ...(typeof session.resource_key === 'string' && session.resource_key ? { resourceKey: session.resource_key } : {}),
      ...(typeof session.lease_token === 'string' && session.lease_token ? { leaseToken: session.lease_token } : {}),
      ...(typeof session.requested_by_user_id === 'string' && session.requested_by_user_id ? { requestedByUserId: session.requested_by_user_id } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(latestTokenUsage ? { latestTokenUsage } : {}),
    };
  });
  if (recoverable.length === 0) return [];
  db.run(
    `UPDATE sessions
     SET recovery_previous_status = CASE WHEN status = 'recovering' THEN recovery_previous_status ELSE status END,
         status = 'recovering', updated_at = ?
     WHERE status IN ('pending', 'processing', 'awaiting_action', 'stopping', 'recovering')`,
    [Date.now()],
  );
  db.saveToFile();
  return recoverable;
}
