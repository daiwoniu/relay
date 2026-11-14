import { v4 as uuid } from 'uuid';
import type { SQLiteDB } from './index.js';

export type ApprovalTrustMode = 'trusted' | 'manual';

export interface ApprovalTrustSetting {
  id: string;
  ownerUserId: string;
  projectId: string | null;
  sessionId: string | null;
  mode: ApprovalTrustMode;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type ApprovalTrustDatabase = Pick<SQLiteDB, 'all' | 'exec' | 'get' | 'run' | 'saveToFile'>;

function transaction<T>(db: Pick<SQLiteDB, 'exec'>, action: () => T): T {
  db.exec('BEGIN');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function parseSetting(row: Record<string, unknown>): ApprovalTrustSetting {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    projectId: row.project_id == null ? null : String(row.project_id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    mode: row.mode as ApprovalTrustMode,
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function ensureApprovalTrustSettingsTable(
  db: Pick<SQLiteDB, 'all' | 'exec'>,
): boolean {
  db.exec('PRAGMA foreign_keys = ON');
  const existed = db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_trust_settings'",
  ).length > 0;
  const hadOwner = existed && db.all("PRAGMA table_info(approval_trust_settings)")
    .some((row) => row.name === 'owner_user_id');
  if (existed && !hadOwner) {
    transaction(db, () => db.exec(`
      ALTER TABLE approval_trust_settings RENAME TO approval_trust_settings_legacy;
      CREATE TABLE approval_trust_settings (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('trusted', 'manual')),
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((project_id IS NOT NULL AND session_id IS NULL AND mode = 'trusted')
          OR (project_id IS NULL AND session_id IS NOT NULL))
      );
      INSERT INTO approval_trust_settings
        (id, owner_user_id, project_id, session_id, mode, expires_at, created_at, updated_at)
      SELECT legacy.id,
        (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1),
        legacy.project_id, legacy.session_id, legacy.mode, legacy.expires_at, legacy.created_at, legacy.updated_at
      FROM approval_trust_settings_legacy legacy;
      DROP TABLE approval_trust_settings_legacy;
    `));
  }
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS approval_trust_settings (
      id         TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      mode       TEXT NOT NULL CHECK(mode IN ('trusted', 'manual')),
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (project_id IS NOT NULL AND session_id IS NULL AND mode = 'trusted')
        OR (project_id IS NULL AND session_id IS NOT NULL)
      )
    );
    DROP INDEX IF EXISTS idx_approval_trust_project;
    DROP INDEX IF EXISTS idx_approval_trust_session;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_trust_owner_project
      ON approval_trust_settings(owner_user_id, project_id) WHERE project_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_trust_owner_session
      ON approval_trust_settings(owner_user_id, session_id) WHERE session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_approval_trust_expiry
      ON approval_trust_settings(expires_at) WHERE expires_at IS NOT NULL;
  `));
  return !existed || !hadOwner;
}

export function isApprovalTrustSettingActive(setting: ApprovalTrustSetting, now: number): boolean {
  return setting.expiresAt === null || setting.expiresAt > now;
}

function validateTimestamp(value: number | null, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label}格式无效`);
  }
}

export interface ApprovalTrustRepository {
  getProjectTrustSetting(ownerUserId: string, projectId: string): ApprovalTrustSetting | null;
  getSessionTrustSetting(ownerUserId: string, sessionId: string): ApprovalTrustSetting | null;
  upsertProjectTrustSetting(input: { ownerUserId: string; projectId: string; expiresAt: number | null; now: number }): ApprovalTrustSetting;
  upsertSessionTrustSetting(input: {
    ownerUserId: string;
    sessionId: string;
    mode: ApprovalTrustMode;
    expiresAt: number | null;
    now: number;
  }): ApprovalTrustSetting;
  deleteProjectTrustSetting(ownerUserId: string, projectId: string): boolean;
  deleteSessionTrustSetting(ownerUserId: string, sessionId: string): boolean;
}

export function createApprovalTrustRepository(
  db: ApprovalTrustDatabase,
  options: { createId?: () => string; save?: () => void } = {},
): ApprovalTrustRepository {
  const createId = options.createId ?? uuid;
  const save = options.save ?? (() => db.saveToFile({ failOnLocked: true }));

  const getProjectTrustSetting = (ownerUserId: string, projectId: string): ApprovalTrustSetting | null => {
    const row = db.get('SELECT * FROM approval_trust_settings WHERE owner_user_id = ? AND project_id = ?', [ownerUserId, projectId]);
    return row ? parseSetting(row) : null;
  };
  const getSessionTrustSetting = (ownerUserId: string, sessionId: string): ApprovalTrustSetting | null => {
    const row = db.get('SELECT * FROM approval_trust_settings WHERE owner_user_id = ? AND session_id = ?', [ownerUserId, sessionId]);
    return row ? parseSetting(row) : null;
  };

  function restoreSetting(
    column: 'project_id' | 'session_id',
    ownerUserId: string,
    scopeId: string,
    setting: ApprovalTrustSetting | null,
  ): void {
    transaction(db, () => {
      if (!setting) {
        db.run(`DELETE FROM approval_trust_settings WHERE owner_user_id = ? AND ${column} = ?`, [ownerUserId, scopeId]);
        return;
      }
      db.run(
        `INSERT INTO approval_trust_settings
         (id, owner_user_id, project_id, session_id, mode, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT ${column === 'project_id'
          ? '(owner_user_id, project_id) WHERE project_id IS NOT NULL'
          : '(owner_user_id, session_id) WHERE session_id IS NOT NULL'} DO UPDATE SET
           id = excluded.id,
           mode = excluded.mode,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
        [
          setting.id,
          setting.ownerUserId,
          setting.projectId,
          setting.sessionId,
          setting.mode,
          setting.expiresAt,
          setting.createdAt,
          setting.updatedAt,
        ],
      );
    });
  }

  function saveOrRestore(
    column: 'project_id' | 'session_id',
    ownerUserId: string,
    scopeId: string,
    previous: ApprovalTrustSetting | null,
  ): void {
    try {
      save();
    } catch (error) {
      try {
        restoreSetting(column, ownerUserId, scopeId, previous);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], '授权信任保存失败且内存状态恢复失败');
      }
      throw error;
    }
  }

  function upsert(input: {
    ownerUserId: string;
    projectId: string | null;
    sessionId: string | null;
    mode: ApprovalTrustMode;
    expiresAt: number | null;
    now: number;
  }): ApprovalTrustSetting {
    if (!input.ownerUserId) throw new Error('授权信任设置账号不能为空');
    if (!input.projectId && !input.sessionId) throw new Error('授权信任作用域不能为空');
    if (input.projectId && input.sessionId) throw new Error('授权信任作用域不能重复');
    if (input.projectId && input.mode !== 'trusted') throw new Error('项目只支持 trusted 模式');
    if (input.mode !== 'trusted' && input.mode !== 'manual') throw new Error('授权信任模式无效');
    validateTimestamp(input.expiresAt, '授权信任到期时间');
    validateTimestamp(input.now, '授权信任更新时间');
    const existing = input.projectId
      ? getProjectTrustSetting(input.ownerUserId, input.projectId)
      : getSessionTrustSetting(input.ownerUserId, input.sessionId!);
    const id = existing?.id ?? createId();
    const conflictTarget = input.projectId
      ? '(owner_user_id, project_id) WHERE project_id IS NOT NULL'
      : '(owner_user_id, session_id) WHERE session_id IS NOT NULL';
    const setting = transaction(db, () => {
      db.run(
        `INSERT INTO approval_trust_settings
         (id, owner_user_id, project_id, session_id, mode, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT ${conflictTarget} DO UPDATE SET
           mode = excluded.mode,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
        [id, input.ownerUserId, input.projectId, input.sessionId, input.mode, input.expiresAt, existing?.createdAt ?? input.now, input.now],
      );
      const row = input.projectId
        ? db.get('SELECT * FROM approval_trust_settings WHERE owner_user_id = ? AND project_id = ?', [input.ownerUserId, input.projectId])
        : db.get('SELECT * FROM approval_trust_settings WHERE owner_user_id = ? AND session_id = ?', [input.ownerUserId, input.sessionId]);
      if (!row) throw new Error('授权信任设置写入后无法读取');
      return parseSetting(row);
    });
    saveOrRestore(input.projectId ? 'project_id' : 'session_id', input.ownerUserId, input.projectId ?? input.sessionId!, existing);
    return setting;
  }

  function remove(column: 'project_id' | 'session_id', ownerUserId: string, id: string): boolean {
    const existing = column === 'project_id'
      ? getProjectTrustSetting(ownerUserId, id)
      : getSessionTrustSetting(ownerUserId, id);
    const changed = transaction(db, () => {
      db.run(`DELETE FROM approval_trust_settings WHERE owner_user_id = ? AND ${column} = ?`, [ownerUserId, id]);
      return Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
    });
    if (changed) saveOrRestore(column, ownerUserId, id, existing);
    return changed;
  }

  return {
    getProjectTrustSetting,
    getSessionTrustSetting,
    upsertProjectTrustSetting: ({ ownerUserId, projectId, expiresAt, now }) => upsert({
      ownerUserId, projectId, sessionId: null, mode: 'trusted', expiresAt, now,
    }),
    upsertSessionTrustSetting: ({ ownerUserId, sessionId, mode, expiresAt, now }) => upsert({
      ownerUserId, projectId: null, sessionId, mode, expiresAt, now,
    }),
    deleteProjectTrustSetting: (ownerUserId, projectId) => remove('project_id', ownerUserId, projectId),
    deleteSessionTrustSetting: (ownerUserId, sessionId) => remove('session_id', ownerUserId, sessionId),
  };
}
