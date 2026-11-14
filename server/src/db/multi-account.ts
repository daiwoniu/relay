import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { SQLiteDB } from './index.js';

type MigrationDatabase = Pick<SQLiteDB, 'all' | 'get' | 'run' | 'exec' | 'saveToFile'>;

export interface FinalizeMultiAccountOptions {
  adminUserId: string;
  workspacePath: string;
  adminSystemProjectId: string;
  now?: number;
  createId?: (userId: string) => string;
  beforeCommit?: () => void;
}

export interface FinalizeMultiAccountResult {
  createdSystemProjects: number;
  backfilledProjects: number;
  backfilledSessions: number;
}

export function normalizeProjectPathForOwnership(projectPath: string): string {
  const normalized = path.normalize(projectPath).replace(/[\\/]+$/, '') || path.parse(projectPath).root;
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function hasColumn(db: Pick<SQLiteDB, 'all'>, table: string, column: string): boolean {
  return db.all(`PRAGMA table_info(${table})`).some((entry) => entry.name === column);
}

function rebuildProjectsForMultiAccount(db: MigrationDatabase): void {
  const rows = db.all('SELECT * FROM projects');
  db.exec('ALTER TABLE projects RENAME TO projects_pre_multi_account');
  db.exec(`
    CREATE TABLE projects (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      path            TEXT NOT NULL,
      normalized_path TEXT,
      owner_user_id   TEXT REFERENCES users(id) ON DELETE RESTRICT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      pinned          INTEGER DEFAULT 0,
      pinned_at       INTEGER,
      is_system       INTEGER DEFAULT 0,
      deleted_at      INTEGER
    )
  `);
  for (const row of rows) {
    db.run(
      `INSERT INTO projects
       (id, name, path, normalized_path, owner_user_id, created_at, updated_at,
        pinned, pinned_at, is_system, deleted_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.name, row.path, normalizeProjectPathForOwnership(String(row.path)),
        row.created_at, row.updated_at, row.pinned || 0, row.pinned_at ?? null,
        row.is_system || 0, row.deleted_at ?? null,
      ],
    );
  }
  db.exec('DROP TABLE projects_pre_multi_account');
}

export function ensureMultiAccountSchema(
  db: MigrationDatabase,
  options: { beforeCommit?: () => void } = {},
): boolean {
  const needsDefaultProject = !hasColumn(db, 'users', 'default_project_id');
  const needsPasswordChange = !hasColumn(db, 'users', 'must_change_password');
  const needsDisabledAt = !hasColumn(db, 'users', 'disabled_at');
  const needsCreateProjectPermission = !hasColumn(db, 'users', 'can_create_project');
  const needsProjectRebuild = !hasColumn(db, 'projects', 'owner_user_id')
    || !hasColumn(db, 'projects', 'normalized_path');
  const needsSessionOwner = !hasColumn(db, 'sessions', 'owner_user_id');
  const needsProjectDeletionProtection = !hasColumn(db, 'projects', 'deletion_protected');
  const needsMemberSessionVisibility = !hasColumn(db, 'projects', 'members_can_view_sessions');
  const changed = needsDefaultProject || needsPasswordChange || needsDisabledAt
    || needsProjectRebuild || needsSessionOwner || needsProjectDeletionProtection || needsMemberSessionVisibility || needsCreateProjectPermission;
  if (!changed) return false;

  const foreignKeysEnabled = Number(db.get('PRAGMA foreign_keys')?.foreign_keys || 0) === 1;
  const legacyAlterTable = Number(db.get('PRAGMA legacy_alter_table')?.legacy_alter_table || 0) === 1;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN');
  try {
    if (needsDefaultProject) db.exec('ALTER TABLE users ADD COLUMN default_project_id TEXT');
    if (needsPasswordChange) db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
    if (needsDisabledAt) db.exec('ALTER TABLE users ADD COLUMN disabled_at INTEGER');
    if (needsCreateProjectPermission) db.exec('ALTER TABLE users ADD COLUMN can_create_project INTEGER NOT NULL DEFAULT 1');
    if (needsProjectRebuild) rebuildProjectsForMultiAccount(db);
    if (needsSessionOwner) {
      db.exec('ALTER TABLE sessions ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT');
    }
    if (needsProjectDeletionProtection) db.exec('ALTER TABLE projects ADD COLUMN deletion_protected INTEGER NOT NULL DEFAULT 0');
    if (needsMemberSessionVisibility) db.exec('ALTER TABLE projects ADD COLUMN members_can_view_sessions INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_normalized_path
      ON projects(owner_user_id, normalized_path)
      WHERE owner_user_id IS NOT NULL
    `);
    options.beforeCommit?.();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacyAlterTable ? 'ON' : 'OFF'}`);
    db.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }
  if (db.all('PRAGMA foreign_key_check').length > 0) {
    throw new Error('多账号结构迁移后外键检查失败');
  }
  db.saveToFile();
  return true;
}

export function finalizeMultiAccountOwnership(
  db: MigrationDatabase,
  options: FinalizeMultiAccountOptions,
): FinalizeMultiAccountResult {
  const admin = db.get('SELECT id, role FROM users WHERE id = ?', [options.adminUserId]);
  if (!admin || admin.role !== 'admin') throw new Error('多账号迁移需要有效管理员');
  const adminSystemProject = db.get('SELECT id FROM projects WHERE id = ?', [options.adminSystemProjectId]);
  if (!adminSystemProject) throw new Error('管理员 Relay 默认项目不存在');

  const now = options.now ?? Date.now();
  const createId = options.createId ?? (() => uuid());
  let createdSystemProjects = 0;
  const backfilledProjects = Number(db.get(
    'SELECT COUNT(*) AS count FROM projects WHERE owner_user_id IS NULL',
  )?.count || 0);
  const backfilledSessions = Number(db.get(
    'SELECT COUNT(*) AS count FROM sessions WHERE owner_user_id IS NULL',
  )?.count || 0);
  const changesBefore = Number(db.get('SELECT total_changes() AS count')?.count ?? 0);
  const normalizedWorkspacePath = normalizeProjectPathForOwnership(options.workspacePath);

  db.exec('BEGIN');
  try {
    db.run(
      `UPDATE projects
       SET owner_user_id = ?, normalized_path = CASE id WHEN ? THEN ? ELSE normalized_path END
       WHERE owner_user_id IS NULL`,
      [options.adminUserId, options.adminSystemProjectId, normalizedWorkspacePath],
    );
    db.run(
      `UPDATE projects SET owner_user_id = ?, normalized_path = ?, is_system = 1
       WHERE id = ? AND (owner_user_id IS NOT ? OR normalized_path IS NOT ? OR is_system IS NOT 1)`,
      [
        options.adminUserId,
        normalizedWorkspacePath,
        options.adminSystemProjectId,
        options.adminUserId,
        normalizedWorkspacePath,
      ],
    );
    db.run(
      `UPDATE sessions
       SET owner_user_id = COALESCE(
         (SELECT projects.owner_user_id FROM projects WHERE projects.id = sessions.project_id),
         ?
       )
       WHERE owner_user_id IS NULL`,
      [options.adminUserId],
    );

    const users = db.all('SELECT id FROM users ORDER BY created_at ASC, id ASC');
    for (const user of users) {
      const userId = String(user.id);
      let systemProject = db.get(
        `SELECT id FROM projects
         WHERE owner_user_id = ? AND is_system = 1 AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
        [userId],
      );
      if (!systemProject) {
        const existingWorkspace = db.get(
          `SELECT id FROM projects
           WHERE owner_user_id = ? AND normalized_path = ? AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1`,
          [userId, normalizeProjectPathForOwnership(options.workspacePath)],
        );
        if (existingWorkspace) {
          db.run('UPDATE projects SET is_system = 1, updated_at = ? WHERE id = ?', [now, existingWorkspace.id]);
          systemProject = existingWorkspace;
        } else {
          const projectId = createId(userId);
          db.run(
            `INSERT INTO projects
             (id, name, path, normalized_path, owner_user_id, created_at, updated_at,
              pinned, pinned_at, is_system, deleted_at)
             VALUES (?, 'Relay 默认项目', ?, ?, ?, ?, ?, 0, NULL, 1, NULL)`,
            [
              projectId, options.workspacePath, normalizeProjectPathForOwnership(options.workspacePath),
              userId, now, now,
            ],
          );
          systemProject = { id: projectId };
          createdSystemProjects += 1;
        }
      }
      const currentDefault = db.get(
        `SELECT projects.id
         FROM users
         JOIN projects ON projects.id = users.default_project_id
         WHERE users.id = ? AND projects.owner_user_id = users.id AND projects.deleted_at IS NULL`,
        [userId],
      );
      if (!currentDefault) {
        db.run('UPDATE users SET default_project_id = ?, updated_at = ? WHERE id = ?', [systemProject.id, now, userId]);
      }
    }

    const missingOwnership = Number(db.get(
      `SELECT
         (SELECT COUNT(*) FROM projects WHERE owner_user_id IS NULL)
         + (SELECT COUNT(*) FROM sessions WHERE owner_user_id IS NULL) AS count`,
    )?.count || 0);
    if (missingOwnership > 0) throw new Error('多账号迁移后仍存在缺失所有者的资源');
    // 共享项目允许成员创建归属自己的会话，会话所有者不必等于项目所有者，这里只校验所有者不缺失。
    options.beforeCommit?.();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (Number(db.get('SELECT total_changes() AS count')?.count ?? 0) !== changesBefore) db.saveToFile();
  return { createdSystemProjects, backfilledProjects, backfilledSessions };
}
