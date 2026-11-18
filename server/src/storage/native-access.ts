import { saveNativePreviewPreferences } from './native-preview-preferences.js';
import { randomUUID } from 'node:crypto';
import type { SQLiteDB } from '../db/index.js';
import type { User } from '../db/query-types.js';
import { presentPublicUser } from '../contracts/index.js';
import { createApprovalTrustRepository } from '../db/approval-trust.js';
import { createApprovalTrustService } from '../services/approval-trust.js';
import { setUserDefaultProjectInDatabase,updateNotificationPreferencesInDatabase } from '../db/queries-account.js';
import { StorageContractError } from './command-boundary.js';
import type { CoreCommand, CoreCommandName } from './contracts.js';
import { saveNativeTheme } from './native-theme.js';
import { changeNativeTools } from './native-tools.js';
import { MAX_AVATAR_BYTES,validateAvatarUpload } from '../auth/avatar.js';

type DB = Pick<SQLiteDB, 'get' | 'all' | 'run' | 'exec' | 'saveToFile'>;
export type AccessActor = { id: string; role: string };
export type AccessScope = { scope: 'project' | 'session'; scopeId: string };
const names = ['account.setProjectCreation', 'account.setDisplayName', 'account.setAvatar', 'account.setDefaultEngine', 'account.setDefaultModel', 'account.setNotifications', 'account.setTheme', 'account.setPreviewPreferences', 'account.changeTools', 'account.setDefaultProject', 'project.setMember', 'project.removeMember', 'approvalTrust.set', 'approvalTrust.clear'] as const;
type Name = typeof names[number];
type Command = Extract<CoreCommand, { name: Name }>;
export function isAccessCommand(name: string): name is Name { return (names as readonly string[]).includes(name); }
function deny(code: ConstructorParameters<typeof StorageContractError>[0]): never { throw new StorageContractError(code); }
export function accessScope(command: Command): AccessScope | null {
  if (command.name.startsWith('account.') && command.name !== 'account.setDefaultProject') return null;
  if ('projectId' in command.input) return { scope: 'project', scopeId: command.input.projectId };
  if ('scope' in command.input) return { scope: command.input.scope, scopeId: command.input.scopeId };
  return null;
}
export function receiptAccessScope(name: CoreCommandName, value: any): AccessScope | null {
  if (name.startsWith('account.') && name !== 'account.setDefaultProject') return null;
  return name.startsWith('approvalTrust.') ? { scope: value.scope, scopeId: value.scopeId } : { scope: 'project', scopeId: value.projectId };
}
export function authorizeAccess(db: DB, actor: AccessActor, name: Name, scope: AccessScope | null) {
  if (['account.setProjectCreation', 'project.setMember', 'project.removeMember'].includes(name) && actor.role !== 'admin') deny('FORBIDDEN');
  if (!scope) return;
  if (!['project', 'session'].includes(scope.scope) || typeof scope.scopeId !== 'string' || !scope.scopeId || scope.scopeId.length > 256) deny('INVALID_ARGUMENT');
  if (scope.scope === 'session') {
    const session = db.get(`SELECT s.owner_user_id FROM sessions s JOIN projects p ON p.id=s.project_id
      WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`, [scope.scopeId]);
    if (!session?.owner_user_id || session.owner_user_id !== actor.id && actor.role !== 'admin') deny('FORBIDDEN');
    return;
  }
  const project = db.get('SELECT owner_user_id FROM projects WHERE id=? AND deleted_at IS NULL', [scope.scopeId]);
  if (!project?.owner_user_id) deny('FORBIDDEN');
  const member = db.get('SELECT role FROM project_members WHERE project_id=? AND user_id=?', [scope.scopeId, actor.id]);
  if (name === 'account.setDefaultProject') {
    if (project.owner_user_id !== actor.id && !['collaborator', 'manager'].includes(member?.role)) deny('FORBIDDEN');
  } else if (project.owner_user_id !== actor.id && actor.role !== 'admin' && !['viewer', 'collaborator', 'manager'].includes(member?.role)) deny('FORBIDDEN');
}
function publicUser(db: DB, id: string) {
  const row = db.get(`SELECT id,username,role,display_name,avatar_updated_at,default_project_id,default_engine,
    default_model_id,must_change_password,disabled_at,can_create_project FROM users WHERE id=?`, [id]);
  if (!row) deny('NOT_FOUND');
  return presentPublicUser(row as User);
}
function audit(db: DB, actor: AccessActor, action: 'account.project_permission' | 'project.member_set' | 'project.member_remove',
  resourceType: 'user' | 'project', id: string, owner: string, now: number) {
  // Permission changes also matter on the administrator's own project; keep its real owner in the audit.
  db.run(`INSERT INTO admin_audit_events(id,actor_user_id,action,resource_type,resource_id,owner_user_id,result,occurred_at)
    VALUES(?,?,?,?,?,?,'succeeded',?)`, [randomUUID(), actor.id, action, resourceType, id, owner, now]);
}
export function approvalTrustService(db: DB, now: number) {
  return createApprovalTrustService({ repository: createApprovalTrustRepository(db), clock: () => now,
    entities: {
      getProject: (id) => { const r = db.get('SELECT id,deleted_at FROM projects WHERE id=?', [id]); return r ? { id: r.id, deletedAt: r.deleted_at } : null; },
      getSession: (id) => { const r = db.get('SELECT id,project_id,deleted_at FROM sessions WHERE id=?', [id]); return r ? { id: r.id, projectId: r.project_id, deletedAt: r.deleted_at } : null; },
    } });
}
export function executeAccess(db: DB, actor: AccessActor, command: Command) {
  const now = Date.now();
  switch (command.name) {
    case 'account.setAvatar': {
      const {mime,data}=command.input;let bytes:Buffer|null=null;
      if(data!==null){bytes=Buffer.from(data,'base64');if(bytes.toString('base64')!==data||!validateAvatarUpload(mime!,bytes).ok)deny('INVALID_ARGUMENT');}
      db.run('UPDATE users SET avatar_mime=?,avatar_data=?,avatar_updated_at=?,updated_at=? WHERE id=?',[mime,bytes,bytes?now:null,now,actor.id]);
      return{user:publicUser(db,actor.id)};
    }
    case 'account.setDefaultEngine': {
      db.run('UPDATE users SET default_model_id=CASE WHEN default_engine=? THEN default_model_id ELSE NULL END,default_engine=?,updated_at=? WHERE id=?',[command.input.engine,command.input.engine,now,actor.id]);
      return{user:publicUser(db,actor.id)};
    }
    case 'account.setDefaultModel': {
      if(db.get('SELECT default_engine FROM users WHERE id=?',[actor.id])?.default_engine!==command.input.expectedEngine)deny('CONFLICT');
      db.run('UPDATE users SET default_model_id=?,updated_at=? WHERE id=?',[command.input.modelId,now,actor.id]);
      return{user:publicUser(db,actor.id)};
    }
    case 'account.setPreviewPreferences':return saveNativePreviewPreferences(db,actor,command.input.changes);
    case 'account.setTheme':return saveNativeTheme(db,actor.id,command.input.settings,now);
    case 'account.changeTools':return changeNativeTools(db,actor.id,command.input,now);
    case 'account.setNotifications':{
      updateNotificationPreferencesInDatabase(db,actor.id,command.input.changes,now);return{userId:actor.id};
    }
    case 'account.setDisplayName': {
      db.run('UPDATE users SET display_name=?,updated_at=? WHERE id=?', [command.input.displayName || null, now, actor.id]);
      return { user: publicUser(db, actor.id) };
    }
    case 'account.setProjectCreation': {
      if (!db.get('SELECT id FROM users WHERE id=?', [command.input.userId])) deny('NOT_FOUND');
      db.run('UPDATE users SET can_create_project=?,updated_at=? WHERE id=?', [Number(command.input.allowed), now, command.input.userId]);
      audit(db, actor, 'account.project_permission', 'user', command.input.userId, command.input.userId, now);
      return { user: publicUser(db, command.input.userId) };
    }
    case 'account.setDefaultProject': {
      setUserDefaultProjectInDatabase(db, actor.id, command.input.projectId, now);
      return { user: publicUser(db, actor.id), projectId: command.input.projectId };
    }
    case 'project.setMember':
    case 'project.removeMember': {
      const { projectId, userId } = command.input;
      const project = db.get('SELECT owner_user_id FROM projects WHERE id=?', [projectId]);
      if (!project?.owner_user_id) deny('STORAGE_UNAVAILABLE');
      if (project.owner_user_id === userId) deny('CONFLICT');
      const user = db.get('SELECT id,default_project_id FROM users WHERE id=?', [userId]);
      if (!user) deny('NOT_FOUND');
      const previous = db.get('SELECT can_view_sessions FROM project_members WHERE project_id=? AND user_id=?', [projectId, userId]);
      let visible = false;
      if (command.name === 'project.setMember') {
        visible = command.input.canViewSessions ?? previous?.can_view_sessions === 1;
        db.run(`INSERT INTO project_members(project_id,user_id,role,can_view_sessions,created_at,updated_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,can_view_sessions=excluded.can_view_sessions,updated_at=excluded.updated_at`,
        [projectId, userId, command.input.role, Number(visible), now, now]);
      } else db.run('DELETE FROM project_members WHERE project_id=? AND user_id=?', [projectId, userId]);
      let defaultProjectId = user.default_project_id ?? null;
      if (defaultProjectId === projectId && (command.name === 'project.removeMember' || command.input.role === 'viewer')) {
        defaultProjectId = db.get(`SELECT p.id FROM projects p
          WHERE p.deleted_at IS NULL AND (p.owner_user_id=? OR EXISTS (
            SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=? AND pm.role IN ('collaborator','manager')))
          ORDER BY (p.owner_user_id=?) DESC,p.is_system DESC,p.created_at,p.id LIMIT 1`, [userId, userId, userId])?.id ?? null;
        db.run('UPDATE users SET default_project_id=?,updated_at=? WHERE id=?', [defaultProjectId, now, userId]);
      }
      audit(db, actor, command.name === 'project.setMember' ? 'project.member_set' : 'project.member_remove', 'project', projectId, project.owner_user_id, now);
      return command.name === 'project.setMember' ? { projectId, userId, role: command.input.role, canViewSessions: visible, defaultProjectId }
        : { projectId, userId, removed: !!previous, defaultProjectId };
    }
    case 'approvalTrust.set': {
      const service = approvalTrustService(db, now); const { scope, scopeId, mode, duration } = command.input;
      const setting = scope === 'project' ? service.setProjectTrust(actor.id, scopeId, duration) : service.setSessionTrust(actor.id, scopeId, mode, duration);
      return { scope, scopeId, setting };
    }
    case 'approvalTrust.clear': {
      const service = approvalTrustService(db, now); const { scope, scopeId } = command.input;
      const cleared = scope === 'project' ? service.clearProjectTrust(actor.id, scopeId) : service.clearSessionTrust(actor.id, scopeId);
      return { scope, scopeId, cleared };
    }
  }
}

export function readUserAvatar(db:Pick<DB,'get'>,userId:string){
  const size=db.get('SELECT length(avatar_data) AS bytes FROM users WHERE id=?',[userId]);
  if(!size?.bytes)return null;if(Number(size.bytes)>MAX_AVATAR_BYTES)deny('PAYLOAD_TOO_LARGE');
  const row=db.get('SELECT avatar_mime,avatar_data FROM users WHERE id=?',[userId]);
  if(!row?.avatar_data)return null;
  const bytes=Buffer.from(row.avatar_data),validation=validateAvatarUpload(String(row.avatar_mime),bytes);
  if(!validation.ok)return null;return{mime:validation.mime,data:bytes.toString('base64')};
}
