import { getDB, type SQLiteDB } from './index.js';

export interface WorkspaceLink {
  id: string;
  workspace_path: string;
  task_id: string;
  session_id: string | null;
  feishu_work_item_id: string | null;
  run_id: string | null;
  relation_source: 'explicit' | 'structured' | 'candidate';
  confidence: 'high' | 'medium' | 'low';
  last_verified_at: number | null;
  created_at: number;
  updated_at: number;
}

type LinkDb = Pick<SQLiteDB, 'run' | 'saveToFile' | 'raw' | 'restoreFromBytes'>;

export function listWorkspaceLinksInDatabase(db: Pick<SQLiteDB, 'all'>, workspacePath: string, taskId?: string): WorkspaceLink[] {
  const sql = taskId
    ? 'SELECT * FROM workspace_console_links WHERE workspace_path = ? AND task_id = ? ORDER BY updated_at DESC'
    : 'SELECT * FROM workspace_console_links WHERE workspace_path = ? ORDER BY updated_at DESC';
  const rows = taskId ? db.all(sql, [workspacePath, taskId]) : db.all(sql, [workspacePath]);
  return rows.map((row) => ({ ...row, session_id: row.session_id || null, feishu_work_item_id: row.feishu_work_item_id || null, run_id: row.run_id || null })) as WorkspaceLink[];
}

export function listWorkspaceLinks(workspacePath: string, taskId?: string): WorkspaceLink[] {
  return listWorkspaceLinksInDatabase(getDB(), workspacePath, taskId);
}

export function insertWorkspaceLinkInDatabase(db: LinkDb, link: WorkspaceLink): void {
  const before = db.raw().export();
  try {
    insertWorkspaceLinkInOpenTransaction(db, link);
    db.saveToFile({ failOnLocked: true });
  } catch (error) {
    db.restoreFromBytes(before);
    throw error;
  }
}

export function insertWorkspaceLinkInOpenTransaction(db: Pick<SQLiteDB, 'run'>, link: WorkspaceLink): void {
  db.run(
    `INSERT INTO workspace_console_links
      (id, workspace_path, task_id, session_id, feishu_work_item_id, run_id, relation_source, confidence, last_verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_path, task_id, session_id, feishu_work_item_id, run_id)
     DO UPDATE SET relation_source = excluded.relation_source, confidence = excluded.confidence,
       last_verified_at = excluded.last_verified_at, updated_at = excluded.updated_at`,
    [link.id, link.workspace_path, link.task_id, link.session_id ?? '', link.feishu_work_item_id ?? '', link.run_id ?? '', link.relation_source, link.confidence, link.last_verified_at, link.created_at, link.updated_at],
  );
}

export function insertWorkspaceLink(link: WorkspaceLink): void {
  insertWorkspaceLinkInDatabase(getDB(), link);
}

export function deleteWorkspaceLink(id: string, workspacePath: string): boolean {
  const db = getDB();
  db.run('DELETE FROM workspace_console_links WHERE id = ? AND workspace_path = ?', [id, workspacePath]);
  const deleted = Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
  if (deleted) db.saveToFile();
  return deleted;
}

export function deleteWorkspaceTaskSessionLinkInDatabase(
  db: Pick<SQLiteDB, 'run' | 'get' | 'saveToFile' | 'raw' | 'restoreFromBytes'>,
  workspacePath: string,
  taskId: string,
  sessionId: string,
): boolean {
  const before = db.raw().export();
  try {
    db.run('DELETE FROM workspace_console_links WHERE workspace_path = ? AND task_id = ? AND session_id = ?', [workspacePath, taskId, sessionId]);
    const deleted = Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
    if (deleted) db.saveToFile({ failOnLocked: true });
    return deleted;
  } catch (error) {
    db.restoreFromBytes(before);
    throw error;
  }
}

export function deleteWorkspaceLinksForSessionsInOpenTransaction(db: Pick<SQLiteDB, 'run'>, sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  const placeholders = sessionIds.map(() => '?').join(', ');
  db.run(`DELETE FROM workspace_console_links WHERE session_id IN (${placeholders})`, sessionIds);
}
