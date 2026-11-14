import type { nativeQueries } from './native-queries.js';
import { canonicalJson, StorageContractError } from './command-boundary.js';
import { ProcessItemDtoSchema } from '../contracts/index.js';

type DB = ReturnType<typeof nativeQueries>;
export function isClosedAsyncQuestion(item: { details?: Record<string, unknown> }) {
  return item.details?.interactionKind === 'async_question' && item.details.resolvedAction === 'cancel';
}

/** A close is a user decision, not a synthetic answer. The caller owns the Native transaction. */
export function closeAsyncQuestion(db: DB, userId: string, sessionId: string, questionId: string) {
  const row = db.get(`SELECT q.item_json,q.answer_message_id,s.owner_user_id,s.message_revision FROM _relay_async_questions q
    JOIN sessions s ON s.id=q.session_id JOIN projects p ON p.id=s.project_id
    WHERE q.session_id=? AND q.question_id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`, [sessionId, questionId]);
  if (!row) throw new StorageContractError('NOT_FOUND');
  if (row.owner_user_id !== userId) throw new StorageContractError('FORBIDDEN');
  if (row.answer_message_id !== null) throw new StorageContractError('CONFLICT');
  const item = ProcessItemDtoSchema.parse(JSON.parse(row.item_json));
  if (isClosedAsyncQuestion(item)) return { item, revision: Number(row.message_revision) };
  item.status = 'completed';
  item.details = { ...item.details, resolvedAction: 'cancel', decisionSource: 'user', decidedAt: Date.now() };
  // Keep item_digest as the original provider observation, so late duplicate observations stay idempotent.
  db.run('UPDATE _relay_async_questions SET item_json=? WHERE session_id=? AND question_id=?', [canonicalJson(item,256*1024), sessionId, questionId]);
  const messages = db.all(`SELECT id,items FROM messages WHERE session_id=? AND role='assistant' AND EXISTS
    (SELECT 1 FROM json_each(CASE WHEN json_valid(items) THEN items ELSE '[]' END) j WHERE json_extract(j.value,'$.id')=?) LIMIT 129`, [sessionId, questionId]);
  if (messages.length > 128) throw new StorageContractError('PAYLOAD_TOO_LARGE');
  for (const message of messages) {
    const items = JSON.parse(message.items).map((entry: { id: string }) => entry.id === questionId ? item : entry);
    db.run('UPDATE messages SET items=? WHERE id=?', [canonicalJson(items), message.id]);
  }
  db.run('UPDATE sessions SET message_revision=message_revision+1 WHERE id=?', [sessionId]);
  return { item, revision: Number(row.message_revision) + 1 };
}

/** A terminal snapshot captured before a close must not resurrect the old pending item. */
export function applyClosedAsyncQuestions(db: DB, sessionId: string, items: string | null) {
  if (!items) return items;
  let values;
  try { values = JSON.parse(items); } catch { return items; }
  if (!Array.isArray(values)) return items;
  let changed = false;
  for (let index = 0; index < values.length; index++) {
    const item = values[index];
    if (item?.details?.interactionKind !== 'async_question') continue;
    const row = db.get('SELECT item_json FROM _relay_async_questions WHERE session_id=? AND question_id=?', [sessionId, item.id]);
    if (!row) continue;
    const authoritative = JSON.parse(row.item_json);
    if (isClosedAsyncQuestion(authoritative)) { values[index] = authoritative; changed = true; }
  }
  return changed ? canonicalJson(values) : items;
}
