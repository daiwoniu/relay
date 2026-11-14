import { v4 as uuid } from 'uuid';
import { getDB, type SQLiteDB } from './index.js';

export const ADMIN_AUDIT_ACTIONS = [
  'account.create', 'account.disable', 'account.enable', 'account.reset_password',
  'account.project_permission', 'project.member_set', 'project.member_remove',
  'project.update', 'project.delete', 'project.restore', 'project.permanent_delete',
  'project.upload_delete',
  'session.update', 'session.delete', 'session.restore', 'session.permanent_delete',
  'session.send', 'session.stop', 'session.approval_decide',
  'session.engine_preferences_update', 'session.unarchive', 'session.fork_from',
  'share.create_from_session', 'share.revoke', 'share.delete',
] as const;

export type AdminAuditAction = typeof ADMIN_AUDIT_ACTIONS[number];
export type AdminAuditResourceType = 'user' | 'project' | 'session' | 'share';
export type AdminAuditResult = 'started' | 'succeeded' | 'failed';

export interface AdminAuditInput {
  actorUserId: string;
  action: AdminAuditAction;
  resourceType: AdminAuditResourceType;
  resourceId: string;
  ownerUserId: string;
  result?: AdminAuditResult;
  occurredAt?: number;
}

type AuditDatabase = Pick<SQLiteDB, 'all' | 'run' | 'exec' | 'saveToFile'>;
const ALLOWED_INPUT_KEYS = new Set(['actorUserId', 'action', 'resourceType', 'resourceId', 'ownerUserId', 'result', 'occurredAt']);
const RESOURCE_TYPES = new Set<AdminAuditResourceType>(['user', 'project', 'session', 'share']);
const RESULTS = new Set<AdminAuditResult>(['started', 'succeeded', 'failed']);

function createAdminAuditTableSql(table = 'admin_audit_events'): string {
  const actions = ADMIN_AUDIT_ACTIONS.map((action) => `'${action}'`).join(',');
  return `
    CREATE TABLE ${table} (
      id            TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      action        TEXT NOT NULL CHECK(action IN (${actions})),
      resource_type TEXT NOT NULL CHECK(resource_type IN ('user','project','session','share')),
      resource_id   TEXT NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      result        TEXT NOT NULL CHECK(result IN ('started','succeeded','failed')),
      occurred_at   INTEGER NOT NULL
    )`;
}

export function ensureAdminAuditTable(db: Pick<SQLiteDB, 'all' | 'exec'>): boolean {
  const row = db.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_audit_events'")[0];
  const currentSql = String(row?.sql || '');
  if (currentSql.includes("'started'") && ADMIN_AUDIT_ACTIONS.every((action) => currentSql.includes(`'${action}'`))) return false;
  if (!row) {
    db.exec(`${createAdminAuditTableSql()};
    CREATE INDEX idx_admin_audit_occurred_at ON admin_audit_events(occurred_at DESC, id DESC);
    CREATE INDEX idx_admin_audit_owner ON admin_audit_events(owner_user_id, occurred_at DESC);
    `);
    return true;
  }
  const columns = new Set(db.all('PRAGMA table_info(admin_audit_events)').map((column) => String(column.name)));
  db.exec('BEGIN');
  try {
    db.exec(`
      ALTER TABLE admin_audit_events RENAME TO admin_audit_events_legacy;
      ${createAdminAuditTableSql()};
      INSERT INTO admin_audit_events
        (id, actor_user_id, action, resource_type, resource_id, owner_user_id, result, occurred_at)
      SELECT id, actor_user_id, action, resource_type, resource_id, owner_user_id,
        ${columns.has('result') ? 'result' : "'succeeded'"}, occurred_at
      FROM admin_audit_events_legacy;
      DROP TABLE admin_audit_events_legacy;
      CREATE INDEX idx_admin_audit_occurred_at ON admin_audit_events(occurred_at DESC, id DESC);
      CREATE INDEX idx_admin_audit_owner ON admin_audit_events(owner_user_id, occurred_at DESC);
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

export function appendAdminAuditEventInDatabase(
  db: AuditDatabase,
  input: AdminAuditInput,
  createId: () => string = uuid,
): boolean {
  const keys = Object.keys(input as object);
  if (keys.some((key) => !ALLOWED_INPUT_KEYS.has(key))) {
    throw new Error('管理员审计只允许固定元数据字段');
  }
  const result = input.result ?? 'succeeded';
  if (!ADMIN_AUDIT_ACTIONS.includes(input.action) || !RESOURCE_TYPES.has(input.resourceType) || !RESULTS.has(result)) {
    throw new Error('管理员审计动作或资源类型不在白名单中');
  }
  if (!input.actorUserId || !input.resourceId || !input.ownerUserId) throw new Error('管理员审计元数据不完整');
  if (input.actorUserId === input.ownerUserId) return false;
  const actor = db.all('SELECT role FROM users WHERE id = ?', [input.actorUserId])[0];
  if (actor?.role !== 'admin') throw new Error('只有管理员代操作可以写入管理员审计');
  db.run(
    `INSERT INTO admin_audit_events
     (id, actor_user_id, action, resource_type, resource_id, owner_user_id, result, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [createId(), input.actorUserId, input.action, input.resourceType, input.resourceId, input.ownerUserId, result, input.occurredAt ?? Date.now()],
  );
  db.saveToFile();
  return true;
}

export function recordAdminAudit(input: AdminAuditInput): boolean {
  return appendAdminAuditEventInDatabase(getDB(), input);
}

export function runAdminAuditedAction<T>(input: AdminAuditInput, action: () => T): T {
  return runAdminAuditedExternalSyncAction(input, action);
}

export async function runAdminAuditedExternalAction<T>(input: AdminAuditInput, action: () => Promise<T> | T): Promise<T> {
  if (input.actorUserId === input.ownerUserId) return action();
  recordAdminAudit({ ...input, result: 'started' });
  try {
    const result = await action();
    try { recordAdminAudit({ ...input, result: 'succeeded' }); }
    catch (auditError) { console.error('[Relay] 管理员成功操作终态审计写入失败:', auditError); }
    return result;
  } catch (error) {
    try { recordAdminAudit({ ...input, result: 'failed' }); }
    catch (auditError) { console.error('[Relay] 管理员失败操作终态审计写入失败:', auditError); }
    throw error;
  }
}

export function runAdminAuditedExternalSyncAction<T>(input: AdminAuditInput, action: () => T): T {
  if (input.actorUserId === input.ownerUserId) return action();
  recordAdminAudit({ ...input, result: 'started' });
  try {
    const result = action();
    try { recordAdminAudit({ ...input, result: 'succeeded' }); }
    catch (auditError) { console.error('[Relay] 管理员成功操作终态审计写入失败:', auditError); }
    return result;
  } catch (error) {
    try { recordAdminAudit({ ...input, result: 'failed' }); }
    catch (auditError) { console.error('[Relay] 管理员失败操作终态审计写入失败:', auditError); }
    throw error;
  }
}

export function runAdminAuditedOutcome<T>(input: AdminAuditInput, action: () => T, succeeded: (result: T) => boolean): T {
  if (input.actorUserId === input.ownerUserId) return action();
  recordAdminAudit({ ...input, result: 'started' });
  try {
    const result = action();
    try { recordAdminAudit({ ...input, result: succeeded(result) ? 'succeeded' : 'failed' }); }
    catch (auditError) { console.error('[Relay] 管理员操作终态审计写入失败:', auditError); }
    return result;
  } catch (error) {
    try { recordAdminAudit({ ...input, result: 'failed' }); } catch {}
    throw error;
  }
}
