import type { SQLiteDB } from './index.js';

export type ProjectMemberRole = 'viewer' | 'collaborator' | 'manager';

function hasTable(db: Pick<SQLiteDB, 'all'>): boolean {
  return db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='project_members'").length > 0;
}

function hasColumn(db: Pick<SQLiteDB, 'all'>, table: string, column: string): boolean {
  return db.all(`PRAGMA table_info(${table})`).some((entry) => entry.name === column);
}

export function ensureProjectMembersTable(db: Pick<SQLiteDB, 'exec' | 'all'>): boolean {
  if (!hasTable(db)) {
    db.exec(`CREATE TABLE project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('viewer','collaborator','manager')),
      can_view_sessions INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, user_id)
    );
    CREATE INDEX idx_project_members_user ON project_members(user_id);`);
    return true;
  }
  if (hasColumn(db, 'project_members', 'can_view_sessions')) return false;
  db.exec('ALTER TABLE project_members ADD COLUMN can_view_sessions INTEGER NOT NULL DEFAULT 0');
  db.exec(`UPDATE project_members
    SET can_view_sessions = 1
    WHERE project_id IN (SELECT id FROM projects WHERE members_can_view_sessions = 1)`);
  return true;
}

export function getProjectMemberRole(db: Pick<SQLiteDB, 'get'>, projectId: string, userId: string): ProjectMemberRole | null {
  return (db.get('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, userId])?.role as ProjectMemberRole | undefined) ?? null;
}