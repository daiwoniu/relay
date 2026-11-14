import type { nativeQueries } from './native-queries.js';
import { StorageContractError } from './command-boundary.js';
import { presentPendingApproval } from '../ws/pending-approvals.js';

/** Async answers are owner-only and remain actionable after their originating turn ends. */
export function pendingAsyncQuestions(db: ReturnType<typeof nativeQueries>, userId: string) {
  const rows = db.all(`SELECT q.session_id,q.created_at,s.title,
    CASE WHEN length(CAST(q.item_json AS BLOB))<=262144 THEN q.item_json ELSE NULL END AS item_json
    FROM _relay_async_questions q JOIN sessions s ON s.id=q.session_id JOIN projects p ON p.id=s.project_id
    WHERE q.answer_message_id IS NULL AND s.owner_user_id=? AND s.engine='codex'
    AND coalesce(json_extract(q.item_json,'$.details.resolvedAction'),'')<>'cancel'
    AND s.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY q.created_at,q.session_id,q.question_id LIMIT 513`, [userId]);
  if (rows.length > 512) throw new StorageContractError('PAYLOAD_TOO_LARGE');
  return rows.map(row => {
    if (typeof row.item_json !== 'string') throw new StorageContractError('PAYLOAD_TOO_LARGE');
    let item;
    try { item = JSON.parse(row.item_json); } catch { throw new StorageContractError('STORAGE_UNAVAILABLE'); }
    const question = presentPendingApproval({ sessionId: row.session_id, sessionTitle: row.title, engine: 'codex', item, createdAt: row.created_at });
    if (!question || question.kind !== 'async_question') throw new StorageContractError('STORAGE_UNAVAILABLE');
    return question;
  });
}
