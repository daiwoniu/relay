import fs from 'node:fs';
import path from 'node:path';
import { getDB, type SQLiteDB } from '../db/index.js';
import {
  completeTrashCleanupJobInDatabase,
  getTrashCleanupJobInDatabase,
  listPendingTrashCleanupJobsInDatabase,
  markTrashCleanupJobFailedInDatabase,
  markTrashCleanupJobProcessingInDatabase,
  type TrashAttachmentCleanupJobRow,
} from '../db/trash-cleanup-jobs.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type CleanupDatabase = Pick<SQLiteDB, 'all' | 'get' | 'run' | 'saveToFile' | 'raw' | 'restoreFromBytes'>;

function stableCleanupErrorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)) return error.code;
  if (error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)) return error.message;
  return fallback;
}

function validateQuarantinePath(job: TrashAttachmentCleanupJobRow): string {
  if (!UUID_PATTERN.test(job.operation_id)) throw new Error('TRASH_CLEANUP_OPERATION_INVALID');
  const resolved = path.resolve(job.quarantine_path);
  if (path.basename(resolved) !== job.operation_id
    || path.basename(path.dirname(resolved)) !== '.trash-quarantine'
    || path.basename(path.dirname(path.dirname(resolved))) !== '.relay_upload') {
    throw new Error('TRASH_CLEANUP_PATH_INVALID');
  }
  if (!fs.existsSync(resolved)) return resolved;
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(resolved) !== resolved) {
    throw new Error('TRASH_CLEANUP_PATH_INVALID');
  }
  return resolved;
}

export function createTrashAttachmentCleanupService(
  db: CleanupDatabase = getDB(),
  options: { now?: () => number; remove?: (target: string) => void; diagnostic?: (message: string) => void } = {},
) {
  const now = options.now ?? Date.now;
  const remove = options.remove ?? ((target: string) => fs.rmSync(target, { recursive: true, force: true }));
  const cleanup = (job: TrashAttachmentCleanupJobRow): boolean => {
    try {
      markTrashCleanupJobProcessingInDatabase(db, job.operation_id, now());
      const target = validateQuarantinePath(job);
      if (fs.existsSync(target)) remove(target);
      completeTrashCleanupJobInDatabase(db, job.operation_id);
      return true;
    } catch (error) {
      const code = stableCleanupErrorCode(error, 'TRASH_CLEANUP_FAILED');
      try {
        markTrashCleanupJobFailedInDatabase(db, job.operation_id, code, now());
      } catch (persistenceError) {
        const persistenceCode = stableCleanupErrorCode(persistenceError, 'TRASH_CLEANUP_STATE_SAVE_FAILED');
        options.diagnostic?.(`附件清理状态待恢复 ${job.operation_id}: ${persistenceCode}`);
      }
      options.diagnostic?.(`附件清理待重试 ${job.operation_id}: ${code}`);
      return false;
    }
  };
  return {
    cleanupOperation(operationId: string): boolean {
      try {
        const job = getTrashCleanupJobInDatabase(db, operationId);
        return job ? cleanup(job) : true;
      } catch (error) {
        options.diagnostic?.(`附件清理任务读取失败 ${operationId}: ${stableCleanupErrorCode(error, 'TRASH_CLEANUP_JOB_READ_FAILED')}`);
        return false;
      }
    },
    scanPending(limit = 20): { processed: number; pending: number } {
      let jobs: TrashAttachmentCleanupJobRow[];
      try {
        jobs = listPendingTrashCleanupJobsInDatabase(db, limit);
      } catch (error) {
        options.diagnostic?.(`附件清理任务扫描失败: ${stableCleanupErrorCode(error, 'TRASH_CLEANUP_SCAN_FAILED')}`);
        return { processed: 0, pending: 0 };
      }
      let processed = 0;
      for (const job of jobs) if (cleanup(job)) processed += 1;
      return { processed, pending: jobs.length - processed };
    },
  };
}

export type TrashAttachmentCleanupService = ReturnType<typeof createTrashAttachmentCleanupService>;
