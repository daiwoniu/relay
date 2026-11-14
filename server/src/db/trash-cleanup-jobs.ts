import type { SQLiteDB } from './index.js';

export function ensureTrashCleanupJobsTable(
  db: Pick<SQLiteDB, 'exec'>,
): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trash_attachment_cleanup_jobs (
      operation_id TEXT PRIMARY KEY,
      quarantine_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'processing')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trash_attachment_cleanup_jobs_status_created
      ON trash_attachment_cleanup_jobs(status, created_at);
  `);
  return true;
}

export interface TrashAttachmentCleanupJobRow {
  operation_id: string;
  quarantine_path: string;
  status: 'pending' | 'processing';
  attempt_count: number;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
}

type CleanupJobDatabase = Pick<SQLiteDB, 'all' | 'get' | 'run' | 'saveToFile' | 'raw' | 'restoreFromBytes'>;

function mutateAndPersist(db: CleanupJobDatabase, mutation: () => void): void {
  const beforeMutation = db.raw().export();
  try {
    mutation();
    db.saveToFile();
  } catch (error) {
    db.restoreFromBytes(beforeMutation);
    throw error;
  }
}

export function listPendingTrashCleanupJobsInDatabase(
  db: Pick<SQLiteDB, 'all'>,
  limit = 20,
): TrashAttachmentCleanupJobRow[] {
  return db.all(
    `SELECT * FROM trash_attachment_cleanup_jobs
      WHERE status IN ('pending', 'processing')
      ORDER BY created_at ASC, operation_id ASC LIMIT ?`,
    [Math.max(1, Math.min(100, Math.trunc(limit)))],
  ) as unknown as TrashAttachmentCleanupJobRow[];
}

export function getTrashCleanupJobInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  operationId: string,
): TrashAttachmentCleanupJobRow | undefined {
  return db.get(
    'SELECT * FROM trash_attachment_cleanup_jobs WHERE operation_id = ?',
    [operationId],
  ) as unknown as TrashAttachmentCleanupJobRow | undefined;
}

export function markTrashCleanupJobProcessingInDatabase(
  db: CleanupJobDatabase,
  operationId: string,
  now: number,
): TrashAttachmentCleanupJobRow | undefined {
  mutateAndPersist(db, () => db.run(
    `UPDATE trash_attachment_cleanup_jobs
        SET status = 'processing', updated_at = ?
      WHERE operation_id = ?`,
    [now, operationId],
  ));
  return getTrashCleanupJobInDatabase(db, operationId);
}

export function markTrashCleanupJobFailedInDatabase(
  db: CleanupJobDatabase,
  operationId: string,
  errorCode: string,
  now: number,
): void {
  mutateAndPersist(db, () => db.run(
    `UPDATE trash_attachment_cleanup_jobs
        SET status = 'pending', attempt_count = attempt_count + 1,
            last_error_code = ?, updated_at = ?
      WHERE operation_id = ?`,
    [errorCode.slice(0, 100), now, operationId],
  ));
}

export function completeTrashCleanupJobInDatabase(
  db: CleanupJobDatabase,
  operationId: string,
): void {
  mutateAndPersist(db, () => db.run('DELETE FROM trash_attachment_cleanup_jobs WHERE operation_id = ?', [operationId]));
}
