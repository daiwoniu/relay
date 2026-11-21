import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SQLiteDB } from '../db/index.js';
import { normalizeProjectPathForOwnership } from '../db/multi-account.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
import { updateSessionEnginePreferencesInDatabase } from '../db/queries-session-preferences.js';
import { StorageContractError } from './command-boundary.js';
import type { CoreCommand, CoreCommandName } from './contracts.js';
type DB = Pick<SQLiteDB, 'get' | 'all' | 'run' | 'exec' | 'saveToFile'>;
type Actor = { id: string; role: string };
const names = ['project.create', 'project.update', 'session.create', 'session.update', 'session.setPreferences'] as const;
type Name = typeof names[number];
type Command = Extract<CoreCommand, { name: Name }>;
export function isResourceWrite(name: string): name is Name { return (names as readonly string[]).includes(name); }
function deny(code: ConstructorParameters<typeof StorageContractError>[0]): never { throw new StorageContractError(code); }
export function requireManagedResource(db: DB, actor: Actor, kind: 'project' | 'session', id: string) {
  const row = kind === 'project'
    ? db.get('SELECT owner_user_id,id FROM projects WHERE id=? AND deleted_at IS NULL', [id])
    : db.get(`SELECT s.owner_user_id,s.project_id,s.status,s.engine_bound,s.selected_model_id,s.selected_service_tier FROM sessions s JOIN projects p ON p.id=s.project_id
      WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL`, [id]);
  if (!row?.owner_user_id || row.owner_user_id !== actor.id && actor.role !== 'admin') deny('FORBIDDEN');
  return row;
}
export function authorizeResourceReceipt(db: DB, actor: Actor, name: CoreCommandName, value: any) {
  if (!isResourceWrite(name)) deny('INVALID_ARGUMENT');
  requireManagedResource(db, actor, name.startsWith('project.') ? 'project' : 'session', name.startsWith('project.') ? value.projectId : value.sessionId);
}
export function createOwnedProject(db: DB, ownerId: string, id: string, projectPath: string, name: string, now: number) {
  if (!path.isAbsolute(projectPath) || projectPath.includes('\0')) deny('INVALID_ARGUMENT');
  const normalized = normalizeProjectPathForOwnership(projectPath);
  const previous = db.get('SELECT id,deleted_at FROM projects WHERE owner_user_id=? AND normalized_path=?', [ownerId, normalized]);
  if (previous) { if (previous.deleted_at !== null) deny('CONFLICT'); return { projectId: String(previous.id), created: false }; }
  db.run(`INSERT INTO projects(id,name,path,normalized_path,owner_user_id,created_at,updated_at,pinned,pinned_at,is_system,deleted_at)
    VALUES(?,?,?,?,?,?,?,0,NULL,0,NULL)`, [id, name, projectPath, normalized, ownerId, now, now]);
  return { projectId: id, created: true };
}
/** No filesystem operations here: the application adapter must realpath/check directories before submitting. */
export function resolveSessionProject(db: DB, actor: Actor, requested: string | null, ownerId = actor.id): string {
  const id = requested ?? db.get('SELECT default_project_id FROM users WHERE id=?', [ownerId])?.default_project_id;
  const project = id ? db.get('SELECT id,path,name,owner_user_id FROM projects WHERE id=? AND deleted_at IS NULL', [id]) : undefined;
  if (!project?.owner_user_id) deny('FORBIDDEN');
  if (project.owner_user_id === ownerId) return String(project.id);
  const member = db.get('SELECT role FROM project_members WHERE project_id=? AND user_id=?', [project.id, ownerId]);
  if (requested === null) {
    if (!['collaborator', 'manager'].includes(String(member?.role))) deny('FORBIDDEN');
    return String(project.id);
  }
  if (actor.role === 'admin') return createOwnedProject(db, ownerId, randomUUID(), String(project.path), String(project.name), Date.now()).projectId;
  if (!['collaborator', 'manager'].includes(String(member?.role))) deny('FORBIDDEN');
  return String(project.id);
}
export function executeResourceWrite(db: DB, actor: Actor, command: Command) {
  const now = Date.now();
  if (command.name === 'project.create') {
    if (actor.role !== 'admin' && db.get('SELECT can_create_project FROM users WHERE id=?', [actor.id])?.can_create_project === 0) deny('FORBIDDEN');
    return createOwnedProject(db, actor.id, command.input.projectId, command.input.path, command.input.name, now);
  }
  if (command.name === 'session.create') {
    const input = command.input;
    if (db.get('SELECT id FROM sessions WHERE id=?', [input.sessionId])) deny('CONFLICT');
    const projectId = resolveSessionProject(db, actor, input.projectId);
    const user = db.get('SELECT default_engine,default_model_id,default_reasoning_effort,default_service_tier FROM users WHERE id=?',[actor.id]);
    const defaults = input.engine !== null && input.engine === user?.default_engine ? user : undefined;
    db.run(`INSERT INTO sessions(id,title,title_manually_set,created_at,updated_at,project_id,owner_user_id,engine,engine_bound,status,
      message_revision,context_compaction_count,engine_preferences_revision,selected_model_id,selected_reasoning_effort,selected_service_tier) VALUES(?,?,?,?,?,?,?,?,?,'idle',0,0,0,?,?,?)`,
    [input.sessionId, input.title ?? '新对话', Number(input.title !== null), now, now, projectId, actor.id, input.engine ?? 'codex', Number(input.engine !== null),defaults?.default_model_id??null,defaults?.default_reasoning_effort??null,defaults?.default_service_tier??null]);
    return { sessionId: input.sessionId, projectId };
  }
  const kind = command.name === 'project.update' ? 'project' : 'session';
  const id = 'projectId' in command.input ? command.input.projectId : command.input.sessionId;
  const row = requireManagedResource(db, actor, kind, id);
  const action = command.name === 'project.update' ? 'project.update' : command.name === 'session.setPreferences' ? 'session.engine_preferences_update' : 'session.update';
  const audit = (result: 'started' | 'succeeded') => {
    if (actor.role === 'admin') appendAdminAuditEventInDatabase(db, { actorUserId: actor.id, ownerUserId: String(row.owner_user_id),
      resourceType: kind, resourceId: id, action, result, occurredAt: now }, randomUUID);
  };
  audit('started');
  if (command.name === 'session.setPreferences') {
    if (row.engine_bound === 0) deny('CONFLICT');
    const serviceTier = command.input.serviceTier === undefined
      ? command.input.modelId === row.selected_model_id ? row.selected_service_tier as string | null : null : command.input.serviceTier;
    const result = updateSessionEnginePreferencesInDatabase(db, id, { ...command.input, serviceTier: serviceTier ?? null });
    if (!result) deny('CONFLICT');
    audit('succeeded'); return { sessionId: id, revision: result.engine_preferences_revision ?? 0 };
  }
  const updates: Array<[string, string | number | null]> = [['updated_at', now]];
  if (command.name === 'project.update') {
    const c = command.input.changes;
    if (c.name !== undefined) updates.push(['name', c.name]);
    if (c.pinned !== undefined) updates.push(['pinned', Number(c.pinned)], ['pinned_at', c.pinned ? now : null]);
    if (c.deletionProtected !== undefined) updates.push(['deletion_protected', Number(c.deletionProtected)]);
  } else {
    const c = command.input.changes;
    if (c.title !== undefined) updates.push(['title', c.title], ['title_manually_set', 1]);
    if (c.pinned !== undefined) updates.push(['pinned', Number(c.pinned)], ['pinned_at', c.pinned ? now : null]);
    if (c.archived !== undefined) updates.push(['archived', Number(c.archived)]);
    if (c.projectId !== undefined) {
      if (!['idle','completed','failed','stopped','interrupted'].includes(String(row.status))) deny('CONFLICT');
      updates.push(['project_id', resolveSessionProject(db, actor, c.projectId, String(row.owner_user_id))]);
    }
  }
  // Column names are fixed server enums above, never supplied by the request.
  db.run(`UPDATE ${kind === 'project' ? 'projects' : 'sessions'} SET ${updates.map(([key]) => key+'=?').join(',')} WHERE id=?`, [...updates.map(([, value]) => value), id]);
  audit('succeeded');
  return kind === 'project' ? { projectId: id } : { sessionId: id, projectId: String(db.get('SELECT project_id FROM sessions WHERE id=?', [id])?.project_id) };
}
