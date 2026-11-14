import { v4 as uuid } from 'uuid';
import { getDB, type SQLiteDB } from './index.js';
import type { Project } from './query-types.js';
import { normalizeProjectPathForOwnership } from './multi-account.js';
import type { ProjectMemberRole } from './project-members.js';

export function listProjectMembers(projectId: string): Array<{ user_id: string; role: ProjectMemberRole; can_view_sessions: 0 | 1 }> {
  return getDB().all('SELECT user_id, role, can_view_sessions FROM project_members WHERE project_id = ? ORDER BY created_at ASC', [projectId]).map((row) => ({
    user_id: String(row.user_id),
    role: row.role as ProjectMemberRole,
    can_view_sessions: row.can_view_sessions === 1 ? 1 : 0,
  }));
}

export function upsertProjectMember(projectId: string, userId: string, role: ProjectMemberRole, canViewSessions?: 0 | 1): void {
  const now = Date.now();
  const existing = getDB().get('SELECT can_view_sessions FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, userId]);
  const visibility = canViewSessions ?? (existing?.can_view_sessions === 1 ? 1 : 0);
  getDB().run(`INSERT INTO project_members (project_id,user_id,role,can_view_sessions,created_at,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role, can_view_sessions=excluded.can_view_sessions, updated_at=excluded.updated_at`, [projectId, userId, role, visibility, now, now]);
  getDB().saveToFile();
}

export function removeProjectMember(projectId: string, userId: string): void {
  getDB().run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, userId]);
  getDB().saveToFile();
}

// ---------- Projects ----------

export function createProject(name: string, projectPath: string, isSystem = false, ownerUserId: string | null = null): Project {
  const db = getDB();
  const now = Date.now();
  const id = uuid();

  db.run(
    'INSERT INTO projects (id, name, path, normalized_path, owner_user_id, created_at, updated_at, pinned, pinned_at, is_system, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL)',
    [id, name, projectPath, normalizeProjectPathForOwnership(projectPath), ownerUserId, now, now, isSystem ? 1 : 0]
  );
  db.saveToFile();

  return { id, name, path: projectPath, normalized_path: normalizeProjectPathForOwnership(projectPath), owner_user_id: ownerUserId, created_at: now, updated_at: now, pinned: 0, pinned_at: null, is_system: isSystem ? 1 : 0, deleted_at: null };
}

export function getProjectForActor(id: string, ownerUserId?: string): Project | undefined {
  if (!ownerUserId) return getProject(id);
  return getDB().get(
    `SELECT * FROM projects
     WHERE id = ? AND deleted_at IS NULL
       AND (owner_user_id = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = ?))`,
    [id, ownerUserId, ownerUserId],
  ) as Project | undefined;
}

export function getProjectByPathForOwner(projectPath: string, ownerUserId: string): Project | undefined {
  return getDB().get(
    'SELECT * FROM projects WHERE owner_user_id = ? AND normalized_path = ?',
    [ownerUserId, normalizeProjectPathForOwnership(projectPath)],
  ) as Project | undefined;
}

export function listProjectsForActor(ownerUserId?: string): Project[] {
  if (!ownerUserId) return listProjects();
  return getDB().all(
    `SELECT * FROM projects
     WHERE deleted_at IS NULL AND (owner_user_id = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = ?))
     ORDER BY created_at ASC`,
    [ownerUserId, ownerUserId],
  ) as Project[];
}

export function getProjectMemberRole(projectId: string, userId: string): ProjectMemberRole | null {
  return (getDB().get('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, userId])?.role as ProjectMemberRole | undefined) ?? null;
}

export function getProject(id: string): Project | undefined {
  const db = getDB();
  return db.get('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL', [id]) as Project | undefined;
}

export function getProjectByPath(projectPath: string): Project | undefined {
  const db = getDB();
  return db.get('SELECT * FROM projects WHERE path = ?', [projectPath]) as Project | undefined;
}

export function restoreProject(id: string, name: string): Project {
  const db = getDB();
  const now = Date.now();
  db.run('UPDATE projects SET name = ?, deleted_at = NULL, pinned = 0, pinned_at = NULL, updated_at = ? WHERE id = ?', [name, now, id]);
  db.saveToFile();
  return db.get('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL', [id]) as Project;
}

export function getDefaultProject(): Project | undefined {
  return getDB().get('SELECT * FROM projects WHERE is_system = 1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1') as Project | undefined;
}

export function listProjects(): Project[] {
  const db = getDB();
  return db.all('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC') as Project[];
}

export function updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'pinned' | 'is_system' | 'deletion_protected' | 'members_can_view_sessions'>>): void {
  const db = getDB();
  const fields: string[] = [];
  const values: any[] = [];
  const now = Date.now();

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.pinned !== undefined) {
    fields.push('pinned = ?');
    values.push(updates.pinned);
    fields.push('pinned_at = ?');
    values.push(updates.pinned ? now : null);
  }
  if (updates.is_system !== undefined) {
    fields.push('is_system = ?');
    values.push(updates.is_system);
  }
  if (updates.deletion_protected !== undefined) {
    fields.push('deletion_protected = ?');
    values.push(updates.deletion_protected);
  }
  if (updates.members_can_view_sessions !== undefined) { fields.push('members_can_view_sessions = ?'); values.push(updates.members_can_view_sessions); }

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  db.run(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, values);
  db.saveToFile();
}

export function migrateDefaultProject(
  id: string,
  projectPath: string,
  name: string,
  duplicateProjectId?: string,
): void {
  const db = getDB();
  migrateDefaultProjectInDatabase(db, id, projectPath, name, duplicateProjectId);
}

export function migrateDefaultProjectInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'run' | 'saveToFile'>,
  id: string,
  projectPath: string,
  name: string,
  duplicateProjectId?: string,
): void {
  db.exec('BEGIN');
  try {
    if (duplicateProjectId && duplicateProjectId !== id) {
      db.run('UPDATE sessions SET project_id = ? WHERE project_id = ?', [id, duplicateProjectId]);
      db.run("DELETE FROM sidebar_order_items WHERE item_type = 'project' AND item_id = ?", [duplicateProjectId]);
      db.run('DELETE FROM projects WHERE id = ?', [duplicateProjectId]);
    }
    db.run(
      'UPDATE projects SET name = ?, path = ?, normalized_path = ?, is_system = 1, updated_at = ? WHERE id = ?',
      [name, projectPath, normalizeProjectPathForOwnership(projectPath), Date.now(), id],
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.saveToFile();
}

export function deleteProject(id: string): void {
  const db = getDB();
  deleteProjectInDatabase(db, id);
}

export function deleteProjectInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'run' | 'saveToFile'>,
  id: string,
  now = Date.now(),
): void {
  db.exec('BEGIN');
  try {
    db.run('UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE project_id = ? AND deleted_at IS NULL', [now, now, id]);
    db.run('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [now, now, id]);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.run("DELETE FROM sidebar_order_items WHERE item_type = 'project' AND item_id = ?", [id]);
  db.run('DELETE FROM sidebar_order_items WHERE scope = ?', [`project:${id}`]);
  db.run('DELETE FROM sidebar_order_scopes WHERE scope = ?', [`project:${id}`]);
  db.run("DELETE FROM sidebar_order_items WHERE item_type = 'session' AND item_id IN (SELECT id FROM sessions WHERE project_id = ?)", [id]);
  db.saveToFile();
}
