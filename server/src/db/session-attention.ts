import type { SQLiteDB } from './index.js';
import type { Session } from './query-types.js';
import type { SessionDto } from '../contracts/dto.js';
import { parseMessageMetadata } from '../message-metadata.js';

// 独立交互卡片保存为空正文 final_answer，不是一次新的任务执行结果。
const RESULT_CANDIDATE_SQL = "latest.role = 'assistant' AND COALESCE(latest.phase, '') <> 'interaction' AND (COALESCE(latest.phase, '') <> 'final_answer' OR length(trim(latest.content)) > 0)";

export function ensureSessionReadReceipts(db: Pick<SQLiteDB, 'exec'>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_read_receipts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL, read_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, session_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_role_created ON messages(session_id, role, created_at)');
}

export function withSessionResults(db: Pick<SQLiteDB, 'all'>, sessions: Session[]): Session[] {
  if (!sessions.length) return sessions;
  const results = new Map<string, NonNullable<SessionDto['last_result']>>();
  // 一次批量查询，每个会话只返回最近结果的元数据，不返回正文或过程项。
  for (let offset = 0; offset < sessions.length; offset += 200) {
    const ids = sessions.slice(offset, offset + 200).map((session) => session.id);
    const rows = db.all(`SELECT m.session_id, m.id, m.turn_id, m.metadata, m.phase, m.stopped, m.created_at
      FROM sessions s JOIN messages m ON m.rowid = (SELECT latest.rowid FROM messages latest
        WHERE latest.session_id = s.id AND ${RESULT_CANDIDATE_SQL}
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)
      WHERE s.id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const row of rows) {
      const metadata = parseMessageMetadata(row.metadata as string | null);
      const status = metadata.outcome ?? (row.stopped === 1 ? 'stopped' : row.phase === 'error' ? 'failed' : row.phase === 'final_answer' ? 'completed' : null);
      if (!status) continue;
      results.set(String(row.session_id), { messageId: String(row.id), turnId: String(row.turn_id), status, createdAt: Number(row.created_at), executionStage: metadata.executionStage });
    }
  }
  return sessions.map((session) => ({ ...session, last_result: results.get(session.id) ?? null }));
}

export function listSessionReadReceipts(db: Pick<SQLiteDB, 'all'>, userId: string): Record<string, string> {
  return Object.fromEntries(db.all(`SELECT r.session_id, r.message_id FROM session_read_receipts r
    JOIN sessions s ON s.id = r.session_id WHERE r.user_id = ? AND s.deleted_at IS NULL`, [userId])
    .map((row) => [String(row.session_id), String(row.message_id)]));
}

export function markSessionResultRead(db: Pick<SQLiteDB, 'get' | 'run' | 'saveToFile'>, userId: string, sessionId: string, messageId: string): boolean {
  const latest = db.get(`SELECT latest.id FROM messages latest WHERE latest.session_id = ? AND ${RESULT_CANDIDATE_SQL} ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1`, [sessionId]);
  if (latest?.id !== messageId) return false;
  if (db.get('SELECT message_id FROM session_read_receipts WHERE user_id = ? AND session_id = ?', [userId, sessionId])?.message_id === messageId) return true;
  db.run(`INSERT INTO session_read_receipts(user_id, session_id, message_id, read_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, session_id) DO UPDATE SET message_id = excluded.message_id, read_at = excluded.read_at`,
  [userId, sessionId, messageId, Date.now()]);
  db.saveToFile();
  return true;
}
