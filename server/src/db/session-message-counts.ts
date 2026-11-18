import type { SQLiteDB } from './index.js';

/** Count persisted rows, independently of message revisions and history pagination. */
export function withSessionMessageCounts<T extends { id: string }>(db: Pick<SQLiteDB, 'all'>, sessions: T[]): Array<T & { message_count: number; assistant_message_count: number }> {
  const counts = new Map<string, { message_count: number; assistant_message_count: number }>();
  for (let offset = 0; offset < sessions.length; offset += 200) {
    const ids = sessions.slice(offset, offset + 200).map((session) => session.id);
    const rows = db.all(`SELECT session_id, COUNT(*) AS message_count,
      SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_message_count
      FROM messages WHERE session_id IN (${ids.map(() => '?').join(',')}) GROUP BY session_id`, ids);
    for (const row of rows) counts.set(String(row.session_id), {
      message_count: Number(row.message_count), assistant_message_count: Number(row.assistant_message_count),
    });
  }
  return sessions.map((session) => ({ ...session, ...(counts.get(session.id) ?? { message_count: 0, assistant_message_count: 0 }) }));
}
