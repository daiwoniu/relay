import type { SQLiteDB } from './index.js';
import { MessageOriginDtoSchema, type MessageOriginDto } from '../contracts/index.js';

export type SessionFollowupState =
  | 'received' | 'steering' | 'steered' | 'queued' | 'dispatching'
  | 'delivered' | 'paused' | 'uncertain' | 'cancelled';

export interface SessionFollowupRecord {
  id: string;
  sessionId: string;
  userId: string;
  content: string;
  attachmentsJson: string;
  replyToAsyncQuestionId: string | null;
  targetTurnId: string | null;
  origin?: MessageOriginDto;
  state: SessionFollowupState;
  createdAt: number;
  updatedAt: number;
  errorCode: string | null;
}

export type NewSessionFollowup = Pick<SessionFollowupRecord,
  'id' | 'sessionId' | 'userId' | 'content' | 'attachmentsJson'
  | 'replyToAsyncQuestionId' | 'targetTurnId' | 'createdAt' | 'origin'>;

type FollowupDatabase = Pick<SQLiteDB, 'get' | 'all' | 'run' | 'exec' | 'saveToFile'>;

const nextStates: Record<SessionFollowupState, readonly SessionFollowupState[]> = {
  received: ['steering', 'queued', 'uncertain', 'cancelled'],
  steering: ['steered', 'queued', 'uncertain'],
  steered: ['uncertain'],
  queued: ['dispatching', 'paused', 'cancelled'],
  dispatching: ['delivered', 'paused', 'uncertain'],
  delivered: [],
  paused: ['queued', 'cancelled'],
  uncertain: ['steered', 'queued', 'paused', 'cancelled'],
  cancelled: [],
};

export function parseFollowup(row: Record<string, any>): SessionFollowupRecord {
  let origin: MessageOriginDto | undefined;
  if (row.origin_json) {
    try {
      const parsed = MessageOriginDtoSchema.safeParse(JSON.parse(String(row.origin_json)));
      if (parsed.success) origin = parsed.data;
    } catch { /* 旧记录或损坏的来源数据不影响后续消息恢复 */ }
  }
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    content: String(row.content),
    attachmentsJson: String(row.attachments_json),
    replyToAsyncQuestionId: row.reply_to_async_question_id == null ? null : String(row.reply_to_async_question_id),
    targetTurnId: row.target_turn_id == null ? null : String(row.target_turn_id),
    ...(origin ? { origin } : {}),
    state: row.state as SessionFollowupState,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    errorCode: row.error_code == null ? null : String(row.error_code),
  };
}

export function ensureSessionFollowupsTable(db: Pick<SQLiteDB, 'get' | 'exec'>): boolean {
  if (db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_followups'")) {
    const columns = db.get("SELECT COUNT(*) AS count FROM pragma_table_info('session_followups') WHERE name = 'origin_json'");
    if (Number(columns?.count) > 0) return false;
    db.exec('ALTER TABLE session_followups ADD COLUMN origin_json TEXT');
    return true;
  }
  db.exec(`
    CREATE TABLE session_followups (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      reply_to_async_question_id TEXT,
      target_turn_id TEXT,
      origin_json TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'received','steering','steered','queued','dispatching',
        'delivered','paused','uncertain','cancelled'
      )),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      error_code TEXT
    );
    CREATE INDEX idx_session_followups_fifo
      ON session_followups(session_id, state, created_at, id);
    CREATE UNIQUE INDEX idx_session_followups_active_question
      ON session_followups(session_id, reply_to_async_question_id)
      WHERE reply_to_async_question_id IS NOT NULL AND state != 'cancelled';
  `);
  return true;
}

export function insertSessionFollowup(db: FollowupDatabase, input: NewSessionFollowup): SessionFollowupRecord {
  const existing = db.get('SELECT * FROM session_followups WHERE id = ?', [input.id]);
  if (existing) {
    const record = parseFollowup(existing);
    if (record.sessionId === input.sessionId && record.userId === input.userId
      && record.content === input.content && record.attachmentsJson === input.attachmentsJson
      && record.replyToAsyncQuestionId === input.replyToAsyncQuestionId) {
      db.saveToFile();
      return record;
    }
    throw new Error('后续消息 ID 已被其他内容使用');
  }
  db.exec('BEGIN');
  try {
    db.run(`INSERT INTO session_followups (
      id, session_id, user_id, content, attachments_json, reply_to_async_question_id,
      target_turn_id, origin_json, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`, [
      input.id, input.sessionId, input.userId, input.content, input.attachmentsJson,
      input.replyToAsyncQuestionId, input.targetTurnId, input.origin ? JSON.stringify(input.origin) : null,
      input.createdAt, input.createdAt,
    ]);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.saveToFile();
  return parseFollowup(db.get('SELECT * FROM session_followups WHERE id = ?', [input.id])!);
}

export function transitionSessionFollowup(
  db: FollowupDatabase,
  input: { id: string; from: SessionFollowupState; to: SessionFollowupState; updatedAt: number; errorCode?: string | null },
): SessionFollowupRecord {
  if (!nextStates[input.from].includes(input.to)) throw new Error('后续消息状态迁移无效');
  db.run(`UPDATE session_followups SET state = ?, updated_at = ?, error_code = ?
    WHERE id = ? AND state = ?`, [input.to, input.updatedAt, input.errorCode ?? null, input.id, input.from]);
  if (Number(db.get('SELECT changes() AS count')?.count) !== 1) throw new Error('后续消息状态已变化');
  const row = db.get('SELECT * FROM session_followups WHERE id = ?', [input.id]);
  if (!row || row.state !== input.to) throw new Error('后续消息状态已变化');
  db.saveToFile();
  return parseFollowup(row);
}

export function listSessionFollowups(db: Pick<SQLiteDB, 'all'>, sessionId: string): SessionFollowupRecord[] {
  return db.all('SELECT * FROM session_followups WHERE session_id = ? ORDER BY created_at ASC, id ASC', [sessionId]).map(parseFollowup);
}

export function listDispatchableFollowups(db: Pick<SQLiteDB, 'all'>): SessionFollowupRecord[] {
  return db.all("SELECT * FROM session_followups WHERE state = 'queued' ORDER BY created_at ASC, id ASC").map(parseFollowup);
}
