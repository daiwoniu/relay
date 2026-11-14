import fs from 'node:fs';
import { compactMessageItemsJsonForStorage } from '../messages/storage.js';
import type { SQLiteDB } from './index.js';

export const PROCESS_ITEM_COMPACTION_BACKUP_SUFFIX = '.pre-process-items-v1.bak';

type CompactionDatabase = Pick<SQLiteDB, 'all' | 'run' | 'exec'>;

interface MessageItemChange {
  id: string;
  value: string;
  beforeBytes: number;
  afterBytes: number;
}

export interface ProcessItemCompactionResult {
  changedMessages: number;
  beforeBytes: number;
  afterBytes: number;
}

export interface ProcessItemCompactionOptions {
  beforeCommit?: () => void;
}

function collectMessageItemChanges(db: Pick<SQLiteDB, 'all'>): MessageItemChange[] {
  return db.all("SELECT id, items FROM messages WHERE role = 'assistant' AND items IS NOT NULL").flatMap((row) => {
    const current = typeof row.items === 'string' ? row.items : null;
    const compacted = compactMessageItemsJsonForStorage(current);
    if (!compacted.changed || compacted.value === null) return [];
    return [{
      id: String(row.id),
      value: compacted.value,
      beforeBytes: compacted.beforeBytes,
      afterBytes: compacted.afterBytes,
    }];
  });
}

function summarizeChanges(changes: MessageItemChange[]): ProcessItemCompactionResult {
  return changes.reduce<ProcessItemCompactionResult>((result, change) => ({
    changedMessages: result.changedMessages + 1,
    beforeBytes: result.beforeBytes + change.beforeBytes,
    afterBytes: result.afterBytes + change.afterBytes,
  }), { changedMessages: 0, beforeBytes: 0, afterBytes: 0 });
}

function applyMessageItemChanges(
  db: CompactionDatabase,
  changes: MessageItemChange[],
  options: ProcessItemCompactionOptions,
): ProcessItemCompactionResult {
  if (changes.length === 0) return summarizeChanges(changes);
  db.exec('BEGIN');
  try {
    for (const change of changes) {
      db.run('UPDATE messages SET items = ? WHERE id = ?', [change.value, change.id]);
    }
    options.beforeCommit?.();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('VACUUM');
  return summarizeChanges(changes);
}

function verifyPersistedChanges(
  db: Pick<SQLiteDB, 'raw'>,
  dbPath: string,
  changes: MessageItemChange[],
): void {
  const DatabaseCtor = db.raw().constructor as unknown as new (data?: ArrayLike<number>) => ReturnType<SQLiteDB['raw']>;
  const persisted = new DatabaseCtor(fs.readFileSync(dbPath));
  try {
    for (const change of changes) {
      const statement = persisted.prepare('SELECT items FROM messages WHERE id = ?');
      try {
        statement.bind([change.id]);
        if (!statement.step() || statement.getAsObject().items !== change.value) {
          throw new Error(`消息过程项迁移未完整保存：${change.id}`);
        }
      } finally {
        statement.free();
      }
    }
  } finally {
    persisted.close();
  }
}

export function compactStoredMessageItemsInDatabase(
  db: CompactionDatabase,
  options: ProcessItemCompactionOptions = {},
): ProcessItemCompactionResult {
  return applyMessageItemChanges(db, collectMessageItemChanges(db), options);
}

export function compactStoredMessageItemsOnStartup(
  db: CompactionDatabase & Pick<SQLiteDB, 'saveToFile' | 'raw' | 'restoreFromBytes'>,
  dbPath: string,
): ProcessItemCompactionResult & { backupPath: string | null } {
  const changes = collectMessageItemChanges(db);
  if (changes.length === 0) return { ...summarizeChanges(changes), backupPath: null };

  const backupPath = `${dbPath}${PROCESS_ITEM_COMPACTION_BACKUP_SUFFIX}`;
  if (fs.existsSync(dbPath) && !fs.existsSync(backupPath)) fs.copyFileSync(dbPath, backupPath);
  const beforeMigration = db.raw().export();
  try {
    const result = applyMessageItemChanges(db, changes, {});
    db.saveToFile();
    verifyPersistedChanges(db, dbPath, changes);
    return { ...result, backupPath: fs.existsSync(backupPath) ? backupPath : null };
  } catch (error) {
    db.restoreFromBytes(beforeMigration);
    throw error;
  }
}
