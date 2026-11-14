import { getDB, type SQLiteDB } from './index.js';
import type { Message } from './query-types.js';

export function getAllMessagesInDatabase(db: Pick<SQLiteDB, 'all'>, sessionId: string): Message[] {
  return db.all(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC',
    [sessionId],
  ) as Message[];
}

export function getAllMessages(sessionId: string): Message[] {
  return getAllMessagesInDatabase(getDB(), sessionId);
}
