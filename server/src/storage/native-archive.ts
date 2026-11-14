import { createHash } from 'node:crypto';
import type { SQLiteDB } from '../db/index.js';
import { canonicalJson, StorageContractError } from './command-boundary.js';
type DB = Pick<SQLiteDB, 'get' | 'all' | 'run'>;
export function beginArchiveSnapshot(db: DB) {
  const head = db.get("SELECT latest_issued FROM _relay_storage_observations WHERE scope='codex-archive'");
  const version = Number(head?.latest_issued ?? 0) + 1;
  if (!Number.isSafeInteger(version)) throw new StorageContractError('CONFLICT');
  db.run(`INSERT INTO _relay_storage_observations VALUES('codex-archive',?,0,NULL)
    ON CONFLICT(scope) DO UPDATE SET latest_issued=excluded.latest_issued`, [version]);
  return { version };
}
export function applyArchiveSnapshot(db: DB, input: { version: number; archivedThreadIds: string[] }) {
  const { version, archivedThreadIds } = input;
  const head = db.get("SELECT latest_issued,latest_applied,snapshot_digest FROM _relay_storage_observations WHERE scope='codex-archive'");
  if (!head || version > Number(head.latest_issued)) throw new StorageContractError('CONFLICT');
  if (version < Number(head.latest_applied)) throw new StorageContractError('SUPERSEDED');
  const digest = createHash('sha256').update(canonicalJson(archivedThreadIds)).digest('hex');
  if (version === Number(head.latest_applied)) {
    if (digest !== head.snapshot_digest) throw new StorageContractError('CONFLICT');
    return { version, changedSessionIds: [] }; // Never reapply an old observation over later local edits.
  }
  const archived = new Set(archivedThreadIds);
  const rows = db.all(`SELECT s.id,s.codex_thread_id,s.codex_archived,s.codex_archived_for_trash FROM sessions s
    JOIN projects p ON p.id=s.project_id WHERE s.engine='codex' AND s.engine_bound=1 AND s.archived=0 AND s.deleted_at IS NULL
    AND p.deleted_at IS NULL AND s.owner_user_id IS NOT NULL AND p.owner_user_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM _relay_soft_delete_sessions ss JOIN _relay_soft_delete_jobs j ON j.id=ss.job_id WHERE ss.session_id=s.id AND j.phase IN ('prepared','cancelling')) LIMIT 10001`);
  if (rows.length > 10000) throw new StorageContractError('PAYLOAD_TOO_LARGE');
  const changedSessionIds: string[] = [];
  for (const row of rows) {
    const desired = !!row.codex_thread_id && archived.has(String(row.codex_thread_id));
    if (Boolean(row.codex_archived) === desired && (desired || !row.codex_archived_for_trash)) continue;
    db.run(`UPDATE sessions SET codex_archived=?,codex_archived_for_trash=CASE WHEN ?=0 THEN 0 ELSE codex_archived_for_trash END WHERE id=?`, [Number(desired), Number(desired), row.id]);
    changedSessionIds.push(String(row.id));
  }
  db.run("UPDATE _relay_storage_observations SET latest_applied=?,snapshot_digest=? WHERE scope='codex-archive'", [version, digest]);
  return { version, changedSessionIds };
}
