import type { SQLiteDB } from '../db/index.js';
import type { Project, Session, User } from '../db/query-types.js';
import { presentProject, presentSession, presentSessionDetails, type SessionDto, type SessionDetailsDto } from '../contracts/index.js';
import { withSessionResults } from '../db/session-attention.js';
import { StorageContractError } from './command-boundary.js';
import { isSessionInProgress } from '../services/session-runtime-status.js';

type DB = Pick<SQLiteDB, 'get' | 'all'>;
type Actor = { id: string; role: string };
type Resource = { kind: 'project' | 'session'; id: string };
export function readDeletionImpact(db: DB, actor: Actor, resource: Resource) {
  const row = resource.kind === 'project'
    ? db.get('SELECT owner_user_id FROM projects WHERE id=? AND deleted_at IS NULL', [resource.id])
    : db.get(`SELECT s.owner_user_id,s.codex_thread_id FROM sessions s JOIN projects p ON p.id=s.project_id
      WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL`, [resource.id]);
  if (!row?.owner_user_id || actor.role !== 'admin' && row.owner_user_id !== actor.id) throw new StorageContractError('NOT_FOUND');
  if (resource.kind === 'session') return { hasLinkedCodexThread: Boolean(row.codex_thread_id) };
  const groups = db.all(`SELECT status,count(*) AS n,sum(CASE WHEN coalesce(codex_thread_id,'')<>'' THEN 1 ELSE 0 END) AS linked
    FROM sessions WHERE project_id=? AND deleted_at IS NULL GROUP BY status`, [resource.id]);
  return groups.reduce((value, group) => ({ sessionCount: value.sessionCount + Number(group.n),
    linkedCodexSessionCount: value.linkedCodexSessionCount + Number(group.linked),
    inProgressSessionCount: value.inProgressSessionCount + (isSessionInProgress(String(group.status)) ? Number(group.n) : 0) }),
  { sessionCount: 0, linkedCodexSessionCount: 0, inProgressSessionCount: 0 });
}
/** Invalidation may expose an existing tombstone's ID to its former viewers, never another account's resource. */
export function resourceEvent(db:DB,actor:Actor,resource:Resource,scope:'mine'|'all'){
  if(resource.kind==='project'){
    const row=db.get(`SELECT p.owner_user_id,p.deleted_at,pm.role FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=? WHERE p.id=?`,[actor.id,resource.id]);
    if(!row||!row.owner_user_id||!(actor.role==='admin'&&scope==='all'||row.owner_user_id===actor.id||['viewer','collaborator','manager'].includes(row.role)))return null;
    if(row.deleted_at!==null)return{type:'project_deleted' as const,projectId:resource.id};
    const value=readProject(db,actor,resource.id);return value?{type:'project_updated' as const,project:value}:null;
  }
  const row=db.get(`SELECT s.owner_user_id,s.deleted_at,s.archived,p.owner_user_id AS project_owner,p.deleted_at AS project_deleted,pm.role,pm.can_view_sessions
    FROM sessions s JOIN projects p ON p.id=s.project_id LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=? WHERE s.id=?`,[actor.id,resource.id]);
  if(!row||!row.owner_user_id||!row.project_owner||!(actor.role==='admin'&&scope==='all'||row.owner_user_id===actor.id||row.project_owner===actor.id||['viewer','collaborator','manager'].includes(row.role)&&row.can_view_sessions===1))return null;
  if(row.deleted_at!==null||row.project_deleted!==null||row.archived===1)return{type:'session_deleted' as const,sessionId:resource.id};
  const value=readSession(db,actor,resource.id);return value?{type:'session_updated' as const,sessionId:resource.id,session:value}:null;
}
const projectColumns = `p.id,p.name,p.path,p.created_at,p.updated_at,p.pinned,p.pinned_at,p.is_system,
  p.deletion_protected,p.members_can_view_sessions,p.owner_user_id`;
const sessionColumns = `s.id,s.title,s.created_at,s.updated_at,s.pinned,s.pinned_at,s.project_id,s.engine,s.engine_bound,
  s.codex_thread_id,s.codex_archived,s.status,s.message_revision,s.context_compaction_count,s.selected_model_id,
  s.selected_reasoning_effort,s.selected_service_tier,s.engine_preferences_revision,s.engine_session_id,s.owner_user_id`;
const ownerColumns = `u.id AS owner_id,u.username AS owner_username,u.role AS owner_role,
  u.display_name AS owner_display_name,u.avatar_updated_at AS owner_avatar_updated_at`;
function owner(row: Record<string, any>): User {
  return { id: row.owner_id, username: row.owner_username, role: row.owner_role,
    display_name: row.owner_display_name, avatar_updated_at: row.owner_avatar_updated_at } as User;
}
export function visibleResource(db: DB, actor: Actor, resource: Resource): boolean {
  const row = resource.kind === 'project'
    ? db.get(`SELECT p.owner_user_id,pm.role FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
      WHERE p.id=? AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL`, [actor.id, resource.id])
    : db.get(`SELECT s.owner_user_id,p.owner_user_id AS project_owner_user_id,pm.role,pm.can_view_sessions
      FROM sessions s JOIN projects p ON p.id=s.project_id
      LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
      WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND s.owner_user_id IS NOT NULL AND p.owner_user_id IS NOT NULL`, [actor.id, resource.id]);
  const member = row && ['viewer', 'collaborator', 'manager'].includes(String(row.role));
  return !!row && (actor.role === 'admin' || row.owner_user_id === actor.id
    || resource.kind === 'session' && row.project_owner_user_id === actor.id
    || !!member && (resource.kind === 'project' || row.can_view_sessions === 1));
}
function budget<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 7 * 1024 * 1024) throw new StorageContractError('PAYLOAD_TOO_LARGE');
  return value;
}
function project(row: Record<string, any>, actor: Actor) {
  const role = row.owner_user_id === actor.id ? 'owner' : row.member_role;
  if (role && !['owner', 'viewer', 'collaborator', 'manager'].includes(role)) throw new StorageContractError('STORAGE_UNAVAILABLE');
  return presentProject({ ...row, ...(role ? { access_role: role } : {}) } as Project, owner(row));
}
export function readProject(db: DB, actor: Actor, id: string) {
  if (!visibleResource(db, actor, { kind: 'project', id })) return null;
  const row = db.get(`SELECT ${projectColumns},${ownerColumns},pm.role AS member_role FROM projects p JOIN users u ON u.id=p.owner_user_id
    LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=? WHERE p.id=?`, [actor.id, id]);
  if (!row) throw new StorageContractError('STORAGE_UNAVAILABLE');
  return budget(project(row, actor));
}
export function listProjects(db: DB, actor: Actor, scope: 'mine' | 'all') {
  const rows = db.all(`SELECT ${projectColumns},${ownerColumns},pm.role AS member_role FROM projects p JOIN users u ON u.id=p.owner_user_id
    LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=? WHERE p.deleted_at IS NULL
      AND (?=1 OR p.owner_user_id=? OR pm.role IN ('viewer','collaborator','manager'))
    ORDER BY p.created_at,p.id LIMIT 501`, [actor.id, Number(scope === 'all'), actor.id]);
  if (rows.length > 500) throw new StorageContractError('PAYLOAD_TOO_LARGE');
  return budget(rows.map((row) => project(row, actor)));
}
function sessions(db: DB, rows: Record<string, any>[], details = false) {
  const normalized = rows.map((r) => ({ ...r, engine: r.engine_bound === 0 ? null : r.engine })) as Session[];
  return withSessionResults(db, normalized).map((s, i) => {
    const last = s.last_result;
    if (last && last.executionStage === undefined) { const { executionStage, ...defined } = last; s = { ...s, last_result: defined }; }
    return details ? presentSessionDetails(s, owner(rows[i])) : presentSession(s, owner(rows[i]));
  });
}
export function readSession(db: DB, actor: Actor, id: string, details: true): SessionDetailsDto | null;
export function readSession(db: DB, actor: Actor, id: string, details?: false): SessionDto | null;
export function readSession(db: DB, actor: Actor, id: string, details = false) {
  if (!visibleResource(db, actor, { kind: 'session', id })) return null;
  const row = db.get(`SELECT ${sessionColumns},${ownerColumns} FROM sessions s JOIN users u ON u.id=s.owner_user_id WHERE s.id=?`, [id]);
  if (!row) throw new StorageContractError('STORAGE_UNAVAILABLE');
  return budget(sessions(db, [row], details)[0]);
}
export function listSessions(db: DB, actor: Actor, request: { scope: 'mine' | 'all'; projectId: string | null;
  limit: number; before: { updatedAt: number; id: string } | null; offset?: number }) {
  const cursor = request.before;
  const rows = db.all(`SELECT ${sessionColumns},${ownerColumns} FROM sessions s JOIN users u ON u.id=s.owner_user_id
    JOIN projects p ON p.id=s.project_id LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
    WHERE s.deleted_at IS NULL AND s.archived=0 AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL
      AND (?=1 OR s.owner_user_id=? OR p.owner_user_id=? OR (pm.role IN ('viewer','collaborator','manager') AND pm.can_view_sessions=1))
      AND (? IS NULL OR s.project_id=?) ${cursor ? 'AND (s.updated_at<? OR (s.updated_at=? AND s.id<?))' : ''}
    ORDER BY s.updated_at DESC,s.id DESC LIMIT ? OFFSET ?`, [actor.id, Number(request.scope === 'all'), actor.id, actor.id,
      request.projectId, request.projectId, ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []), request.limit+1, request.offset ?? 0]);
  const page = rows.slice(0, request.limit); const result = sessions(db, page); const last = page.at(-1);
  return budget({ sessions: result, nextCursor: rows.length > page.length && last ? { updatedAt: Number(last.updated_at), id: String(last.id) } : null });
}
