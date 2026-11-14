import { createHash } from 'node:crypto';
import type { SQLiteDB } from '../db/index.js';
import type { AdminAuditAction } from '../db/admin-audit.js';
import type { StoragePrincipal } from './contracts.js';

type DB = Pick<SQLiteDB, 'get' | 'run'>;
/** Separate transaction after a proven business rollback. No passwords, SQL or exception text enters audit. */
export function recordRejectedAdminOperation(db: DB, transaction: <T>(work: () => T) => T, input: {
  principal: StoragePrincipal; operationId: string; action: AdminAuditAction;
  resourceType: 'user' | 'project' | 'session' | 'share'; resourceId: string; includeSelf?: boolean;
}) {
  const principal = input.principal;
  if (principal.kind !== 'user') return;
  transaction(() => {
    const now = Date.now();
    if (!db.get(`SELECT u.id FROM users u JOIN auth_sessions a ON a.user_id=u.id
      WHERE u.id=? AND u.role='admin' AND u.disabled_at IS NULL AND u.must_change_password=0
      AND a.token_hash=? AND a.expires_at>?`, [principal.userId, principal.authSessionHash, now])) return;
    const owner = input.resourceType === 'user'
      ? db.get('SELECT id AS owner FROM users WHERE id=?', [input.resourceId])?.owner
      : input.resourceType === 'project' ? db.get('SELECT owner_user_id AS owner FROM projects WHERE id=?', [input.resourceId])?.owner
      : input.resourceType === 'share' ? db.get('SELECT owner_user_id AS owner FROM shared_records WHERE id=?', [input.resourceId])?.owner
      : db.get('SELECT owner_user_id AS owner FROM sessions WHERE id=?', [input.resourceId])?.owner;
    if (!owner || !input.includeSelf && owner === principal.userId) return;
    const id = 'rejected:' + createHash('sha256').update(JSON.stringify([
      principal.userId, input.operationId, input.action, input.resourceType, input.resourceId,
    ])).digest('hex');
    db.run(`INSERT INTO admin_audit_events(id,actor_user_id,action,resource_type,resource_id,owner_user_id,result,occurred_at)
      VALUES(?,?,?,?,?,?,'failed',?) ON CONFLICT(id) DO NOTHING`,
    [id, principal.userId, input.action, input.resourceType, input.resourceId, owner, now]);
  });
}
