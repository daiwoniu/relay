import { z } from 'zod';
import type { SQLiteDB } from './index.js';

export type WorkspaceSnapshotSource = 'dashboard' | 'responsibility' | 'codex_official';

const SCHEMA_VERSION = 1;

export function ensureWorkspaceSnapshotsTable(db: Pick<SQLiteDB, 'exec'>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_snapshots (
    source TEXT NOT NULL CHECK (source IN ('dashboard', 'responsibility', 'codex_official')),
    identity_key TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (source, identity_key)
  )`);
}

export function readWorkspaceSnapshot<T>(
  db: Pick<SQLiteDB, 'get'>,
  source: WorkspaceSnapshotSource,
  identityKey: string,
  schema: z.ZodType<T>,
): { value: T; savedAt: number } | null {
  const row = db.get('SELECT schema_version, data_json, saved_at FROM workspace_snapshots WHERE source = ? AND identity_key = ?', [source, identityKey]);
  if (!row || row.schema_version !== SCHEMA_VERSION || !Number.isSafeInteger(row.saved_at) || row.saved_at < 0) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(row.data_json));
    return parsed.success ? { value: parsed.data, savedAt: row.saved_at } : null;
  } catch { return null; }
}

export function writeWorkspaceSnapshot<T>(
  db: Pick<SQLiteDB, 'get' | 'run' | 'saveToFile'>,
  source: WorkspaceSnapshotSource,
  identityKey: string,
  value: T,
  savedAt: number,
): void {
  const previous = db.get('SELECT schema_version, data_json, saved_at FROM workspace_snapshots WHERE source = ? AND identity_key = ?', [source, identityKey]);
  db.run(`INSERT INTO workspace_snapshots (source, identity_key, schema_version, data_json, saved_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, identity_key) DO UPDATE SET schema_version = excluded.schema_version,
      data_json = excluded.data_json, saved_at = excluded.saved_at`, [source, identityKey, SCHEMA_VERSION, JSON.stringify(value), savedAt]);
  try {
    db.saveToFile({ failOnLocked: true });
  } catch (error) {
    if (previous) {
      db.run('UPDATE workspace_snapshots SET schema_version = ?, data_json = ?, saved_at = ? WHERE source = ? AND identity_key = ?', [
        previous.schema_version, previous.data_json, previous.saved_at, source, identityKey,
      ]);
    } else {
      db.run('DELETE FROM workspace_snapshots WHERE source = ? AND identity_key = ?', [source, identityKey]);
    }
    throw error;
  }
}
