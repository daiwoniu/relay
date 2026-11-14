import type { EngineTerminalDecision, EngineTurnFact } from '../engine/turn-facts.js';
import { isSafeEngineDiagnosticCode } from '../engine/diagnostics.js';
import type { SQLiteDB } from './index.js';
import { z } from 'zod';

type FactDatabase = Pick<SQLiteDB, 'all' | 'exec' | 'get' | 'run'>;

const EmptyPayloadSchema = z.object({}).strict();
const ContentPayloadSchema = z.object({
  hasContent: z.boolean(),
  contentLength: z.number().int().nonnegative(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const ErrorPayloadSchema = z.object({
  capacityFailure:z.object({retryAfterMs:z.number().int().nonnegative().safe().nullable()}).strict().optional(),
  errorCode: z.string().refine(isSafeEngineDiagnosticCode).optional(),
  retryable: z.boolean().optional(),
}).strict();
const InterruptPayloadSchema = z.object({ userInitiated: z.boolean() }).strict();

function parseSafePayload(fact: EngineTurnFact): EngineTurnFact['payload'] {
  const schema = (() => {
    switch (fact.factType) {
      case 'turn_started':
      case 'recovery_in_progress':
        return EmptyPayloadSchema;
      case 'final_answer_completed':
      case 'recovery_completed':
        return ContentPayloadSchema;
      case 'interrupt_confirmed':
        return InterruptPayloadSchema;
      case 'engine_error':
      case 'connection_closed':
      case 'recovery_failed':
      case 'recovery_interrupted':
        return ErrorPayloadSchema;
      default:
        throw new Error(`Invalid engine turn fact type: ${String(fact.factType)}`);
    }
  })();
  const parsed = schema.safeParse(fact.payload);
  if (!parsed.success) throw new Error(`Invalid engine turn fact payload for ${fact.factType}`);
  return parsed.data as EngineTurnFact['payload'];
}

function tableExists(db: Pick<SQLiteDB, 'get'>, name: string): boolean {
  return Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

export function ensureEngineTurnFactTables(db: FactDatabase): boolean {
  const sessionColumns = db.all('PRAGMA table_info(sessions)');
  if (sessionColumns.length === 0) return false;
  const hasAttemptColumn = sessionColumns.some((column) => column.name === 'active_attempt_id');
  const hasFacts = tableExists(db, 'engine_turn_facts');
  const hasDecisions = tableExists(db, 'engine_terminal_decisions');
  if (hasAttemptColumn && hasFacts && hasDecisions) return false;

  db.exec('BEGIN');
  try {
    if (!hasAttemptColumn) {
      db.exec('ALTER TABLE sessions ADD COLUMN active_attempt_id TEXT');
      db.exec(`
        UPDATE sessions
        SET active_attempt_id = 'legacy:' || id || ':' || COALESCE(active_turn_id, 'none') || ':' || COALESCE(CAST(active_turn_started_at AS TEXT), 'none')
        WHERE active_attempt_id IS NULL
          AND status IN ('pending', 'processing', 'awaiting_action', 'stopping', 'recovering')
      `);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS engine_turn_facts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        engine TEXT NOT NULL CHECK(engine IN ('codex','codebuddy','opencode','zcode')),
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
      CREATE INDEX IF NOT EXISTS idx_engine_turn_facts_attempt
        ON engine_turn_facts(session_id, attempt_id, observed_at, sequence);

      CREATE TABLE IF NOT EXISTS engine_terminal_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        engine TEXT NOT NULL CHECK(engine IN ('codex','codebuddy','opencode','zcode')),
        external_turn_id TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed','interrupted','stopped')),
        reason_code TEXT NOT NULL,
        fact_id TEXT NOT NULL REFERENCES engine_turn_facts(id) ON DELETE RESTRICT,
        decided_at INTEGER NOT NULL,
        projected_at INTEGER,
        UNIQUE(session_id, engine, attempt_id)
      );
      CREATE INDEX IF NOT EXISTS idx_engine_terminal_decisions_session
        ON engine_terminal_decisions(session_id, decided_at DESC);
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function parseFact(row: Record<string, any>): EngineTurnFact {
  return {
    id: String(row.id), sessionId: String(row.session_id), attemptId: String(row.attempt_id),
    engineId: row.engine, connectionId: String(row.connection_id),
    ...(row.external_session_id ? { externalSessionId: String(row.external_session_id) } : {}),
    ...(row.external_turn_id ? { externalTurnId: String(row.external_turn_id) } : {}),
    factType: row.fact_type, source: row.source, sequence: Number(row.sequence),
    idempotencyKey: String(row.idempotency_key), observedAt: Number(row.observed_at),
    payload: JSON.parse(String(row.safe_payload_json)),
  };
}

function parseDecision(row: Record<string, any>): EngineTerminalDecision {
  return {
    id: String(row.id), sessionId: String(row.session_id), attemptId: String(row.attempt_id), engineId: row.engine,
    ...(row.external_turn_id ? { externalTurnId: String(row.external_turn_id) } : {}),
    outcome: row.outcome, reasonCode: String(row.reason_code), factId: String(row.fact_id),
    decidedAt: Number(row.decided_at), projectedAt: row.projected_at == null ? null : Number(row.projected_at),
  };
}

export function appendEngineTurnFactInDatabase(db: Pick<SQLiteDB, 'get' | 'run'>, fact: EngineTurnFact) {
  const safePayload = parseSafePayload(fact);
  db.run(
    `INSERT OR IGNORE INTO engine_turn_facts
     (id, session_id, attempt_id, engine, connection_id, external_session_id, external_turn_id,
      fact_type, source, sequence, idempotency_key, observed_at, safe_payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fact.id, fact.sessionId, fact.attemptId, fact.engineId, fact.connectionId,
      fact.externalSessionId ?? null, fact.externalTurnId ?? null, fact.factType, fact.source,
      fact.sequence, fact.idempotencyKey, fact.observedAt, JSON.stringify(safePayload), Date.now()],
  );
  const inserted = Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
  const row = db.get('SELECT * FROM engine_turn_facts WHERE idempotency_key = ?', [fact.idempotencyKey]);
  if (!row) throw new Error('引擎回合事实写入后无法读取');
  return { inserted, fact: parseFact(row) };
}

export function listEngineTurnFactsInDatabase(
  db: Pick<SQLiteDB, 'all'>,
  sessionId: string,
  attemptId: string,
): EngineTurnFact[] {
  return db.all(
    `SELECT * FROM engine_turn_facts
     WHERE session_id = ? AND attempt_id = ?
     ORDER BY observed_at ASC, sequence ASC, id ASC`,
    [sessionId, attemptId],
  ).map(parseFact);
}

export function insertEngineTerminalDecisionInDatabase(
  db: Pick<SQLiteDB, 'get' | 'run'>,
  decision: EngineTerminalDecision,
) {
  db.run(
    `INSERT OR IGNORE INTO engine_terminal_decisions
     (id, session_id, attempt_id, engine, external_turn_id, outcome, reason_code, fact_id, decided_at, projected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [decision.id, decision.sessionId, decision.attemptId, decision.engineId, decision.externalTurnId ?? null,
      decision.outcome, decision.reasonCode, decision.factId, decision.decidedAt, decision.projectedAt],
  );
  const inserted = Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
  const row = db.get(
    'SELECT * FROM engine_terminal_decisions WHERE session_id = ? AND engine = ? AND attempt_id = ?',
    [decision.sessionId, decision.engineId, decision.attemptId],
  );
  if (!row) throw new Error('引擎终态决策写入后无法读取');
  return { inserted, decision: parseDecision(row) };
}

export function getEngineTerminalDecisionInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  sessionId: string,
  engineId: EngineTerminalDecision['engineId'],
  attemptId: string,
): EngineTerminalDecision | null {
  const row = db.get(
    'SELECT * FROM engine_terminal_decisions WHERE session_id = ? AND engine = ? AND attempt_id = ?',
    [sessionId, engineId, attemptId],
  );
  return row ? parseDecision(row) : null;
}

export function markEngineTerminalDecisionProjectedInDatabase(
  db: Pick<SQLiteDB, 'get' | 'run'>,
  decisionId: string,
  projectedAt: number,
): EngineTerminalDecision {
  db.run(
    'UPDATE engine_terminal_decisions SET projected_at = ? WHERE id = ? AND projected_at IS NULL',
    [projectedAt, decisionId],
  );
  const row = db.get('SELECT * FROM engine_terminal_decisions WHERE id = ?', [decisionId]);
  if (!row) throw new Error('引擎终态决定不存在');
  return parseDecision(row);
}
