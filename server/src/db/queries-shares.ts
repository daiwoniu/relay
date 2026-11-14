import { getDB, type SQLiteDB } from './index.js';
import type { SharedRecord, SharedRecordWithSourceTitle } from './query-types.js';

// ---------- Shares ----------

export function createSharedRecordInDatabase(
  db: Pick<SQLiteDB, 'run' | 'saveToFile'>,
  record: SharedRecord,
): SharedRecord {
  db.run(
    `INSERT INTO shared_records (
      id, public_token, owner_user_id, source_session_id, title, scope,
      message_count, include_process, snapshot_version, snapshot_json,
      created_at, expires_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id, record.public_token, record.owner_user_id, record.source_session_id,
      record.title, record.scope, record.message_count, record.include_process,
      record.snapshot_version, record.snapshot_json, record.created_at,
      record.expires_at, record.revoked_at,
    ],
  );
  db.saveToFile();
  return record;
}

export function createSharedRecord(record: SharedRecord): SharedRecord {
  return createSharedRecordInDatabase(getDB(), record);
}

export function listSharedRecordsByOwnerInDatabase(
  db: Pick<SQLiteDB, 'all'>,
  ownerUserId: string,
  limit = 50,
  offset = 0,
): SharedRecordWithSourceTitle[] {
  return db.all(
    `SELECT shared_records.*, sessions.title AS source_session_title,
            sessions.engine AS source_session_engine
     FROM shared_records
     LEFT JOIN sessions ON sessions.id = shared_records.source_session_id
     WHERE shared_records.owner_user_id = ?
     ORDER BY shared_records.created_at DESC, shared_records.id DESC
     LIMIT ? OFFSET ?`,
    [ownerUserId, limit, offset],
  ) as SharedRecordWithSourceTitle[];
}

export function listSharedRecordsByOwner(ownerUserId: string, limit = 50, offset = 0): SharedRecordWithSourceTitle[] {
  return listSharedRecordsByOwnerInDatabase(getDB(), ownerUserId, limit, offset);
}

export function listSharedRecordsForActor(ownerUserId: string | undefined, limit = 50, offset = 0): SharedRecordWithSourceTitle[] {
  return getDB().all(
    `SELECT shared_records.*, sessions.title AS source_session_title,
            sessions.engine AS source_session_engine
       FROM shared_records
       LEFT JOIN sessions ON sessions.id = shared_records.source_session_id
      ${ownerUserId ? 'WHERE shared_records.owner_user_id = ?' : ''}
      ORDER BY shared_records.created_at DESC, shared_records.id DESC
      LIMIT ? OFFSET ?`,
    [...(ownerUserId ? [ownerUserId] : []), limit, offset],
  ) as SharedRecordWithSourceTitle[];
}

export function countSharedRecordsByOwnerInDatabase(db: Pick<SQLiteDB, 'get'>, ownerUserId: string): number {
  return Number(db.get('SELECT COUNT(*) AS count FROM shared_records WHERE owner_user_id = ?', [ownerUserId])?.count || 0);
}

export function countSharedRecordsByOwner(ownerUserId: string): number {
  return countSharedRecordsByOwnerInDatabase(getDB(), ownerUserId);
}

export function countSharedRecordsForActor(ownerUserId?: string): number {
  return Number(getDB().get(
    `SELECT COUNT(*) AS count FROM shared_records ${ownerUserId ? 'WHERE owner_user_id = ?' : ''}`,
    ownerUserId ? [ownerUserId] : [],
  )?.count || 0);
}

export function getSharedRecordByPublicTokenInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  publicToken: string,
): SharedRecord | undefined {
  return db.get('SELECT * FROM shared_records WHERE public_token = ?', [publicToken]) as SharedRecord | undefined;
}

export function getSharedRecordByPublicToken(publicToken: string): SharedRecord | undefined {
  return getSharedRecordByPublicTokenInDatabase(getDB(), publicToken);
}

export function getSharedRecordForOwnerInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  id: string,
  ownerUserId: string,
): SharedRecord | undefined {
  return db.get('SELECT * FROM shared_records WHERE id = ? AND owner_user_id = ?', [id, ownerUserId]) as SharedRecord | undefined;
}

export function getSharedRecordForOwner(id: string, ownerUserId: string): SharedRecord | undefined {
  return getSharedRecordForOwnerInDatabase(getDB(), id, ownerUserId);
}

export function getSharedRecordForActor(id: string, ownerUserId?: string): SharedRecord | undefined {
  return getDB().get(
    `SELECT * FROM shared_records WHERE id = ? ${ownerUserId ? 'AND owner_user_id = ?' : ''}`,
    ownerUserId ? [id, ownerUserId] : [id],
  ) as SharedRecord | undefined;
}

export function revokeSharedRecordInDatabase(
  db: Pick<SQLiteDB, 'run' | 'get' | 'saveToFile'>,
  id: string,
  ownerUserId: string,
  now = Date.now(),
): boolean {
  db.run(
    'UPDATE shared_records SET revoked_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL',
    [now, id, ownerUserId],
  );
  const changed = Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
  if (changed) db.saveToFile();
  return changed;
}

export function revokeSharedRecord(id: string, ownerUserId: string, now = Date.now()): boolean {
  return revokeSharedRecordInDatabase(getDB(), id, ownerUserId, now);
}

export function revokeSharedRecordForActor(id: string, ownerUserId: string | undefined, now = Date.now()): boolean {
  const db = getDB();
  db.run(
    `UPDATE shared_records SET revoked_at = ? WHERE id = ? ${ownerUserId ? 'AND owner_user_id = ?' : ''} AND revoked_at IS NULL`,
    ownerUserId ? [now, id, ownerUserId] : [now, id],
  );
  const changed = Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
  if (changed) db.saveToFile();
  return changed;
}

export function deleteInvalidSharedRecordInDatabase(
  db: Pick<SQLiteDB, 'run' | 'get' | 'saveToFile'>,
  id: string,
  ownerUserId: string,
  now = Date.now(),
): boolean {
  db.run(
    `DELETE FROM shared_records
     WHERE id = ? AND owner_user_id = ?
       AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?))`,
    [id, ownerUserId, now],
  );
  const changed = Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
  if (changed) db.saveToFile();
  return changed;
}

export function deleteInvalidSharedRecord(id: string, ownerUserId: string, now = Date.now()): boolean {
  return deleteInvalidSharedRecordInDatabase(getDB(), id, ownerUserId, now);
}

export function deleteInvalidSharedRecordForActor(id: string, ownerUserId: string | undefined, now = Date.now()): boolean {
  const db = getDB();
  db.run(
    `DELETE FROM shared_records
      WHERE id = ? ${ownerUserId ? 'AND owner_user_id = ?' : ''}
        AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?))`,
    ownerUserId ? [id, ownerUserId, now] : [id, now],
  );
  const changed = Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
  if (changed) db.saveToFile();
  return changed;
}

export function detachShareSourceSessionInDatabase(
  db: Pick<SQLiteDB, 'run'>,
  sessionId: string,
): void {
  db.run('UPDATE shared_records SET source_session_id = NULL WHERE source_session_id = ?', [sessionId]);
}
