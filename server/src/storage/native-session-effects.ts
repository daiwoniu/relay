import { createHash, randomUUID } from 'node:crypto';
import type { SQLiteDB } from '../db/index.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
import { canonicalJson, StorageContractError } from './command-boundary.js';
import { requireManagedResource } from './native-resource-writes.js';
import { beginArchiveSnapshot } from './native-archive.js';
import type { CoreCommand, CoreCommandName } from './contracts.js';
type DB = Pick<SQLiteDB, 'get' | 'all' | 'run' | 'exec' | 'saveToFile'>;
type Actor = { id: string; role: string };
const names = ['session.prepareUnarchive','session.claimUnarchive','session.finishUnarchive'] as const;
type Name = typeof names[number];
type Command = Extract<CoreCommand, { name: Name }>;
export function isSessionEffect(name: string): name is Name { return (names as readonly string[]).includes(name); }
function deny(code: ConstructorParameters<typeof StorageContractError>[0]): never { throw new StorageContractError(code); }
function source(db: DB, actor: Actor, sessionId: string) {
  requireManagedResource(db, actor, 'session', sessionId);
  const row = db.get(`SELECT id,owner_user_id,project_id,engine,engine_bound,codex_thread_id,engine_session_id,message_revision,status,active_attempt_id
    FROM sessions WHERE id=?`, [sessionId]);
  if (!row || row.engine !== 'codex' || row.engine_bound !== 1 || !row.codex_thread_id) deny('CONFLICT');
  if (!['idle','completed','failed','stopped','interrupted'].includes(String(row.status)) || row.active_attempt_id
    || db.get('SELECT 1 AS found FROM engine_resource_leases WHERE session_id=?', [sessionId])) deny('CONFLICT');
  return { row, fingerprint: createHash('sha256').update(canonicalJson({ ...row })).digest('hex') };
}
function operation(db: DB, actor: Actor, sessionId: string, id: string) {
  const op = db.get("SELECT * FROM _relay_external_operations WHERE id=? AND kind='unarchive' AND session_id=?", [id, sessionId]);
  if (!op || op.actor_user_id !== actor.id) deny('FORBIDDEN');
  requireManagedResource(db, actor, 'session', sessionId); return op;
}
export function authorizeSessionEffectReceipt(db: DB, actor: Actor, name: CoreCommandName, value: any) {
  if (!isSessionEffect(name)) deny('INVALID_ARGUMENT');
  const op = operation(db, actor, value.sessionId, value.externalOperationId);
  if (name !== 'session.finishUnarchive' && op.phase !== 'applied' && source(db, actor, value.sessionId).fingerprint !== op.source_digest) deny('CONFLICT');
}
export function checkSessionEffectFence(db: DB, actor: Actor, sessionId: string, id: string, phase = 'applied') {
  const op = operation(db, actor, sessionId, id);
  if (op.phase !== phase) return false;
  try { return source(db, actor, sessionId).fingerprint === op.source_digest; }
  catch (error) { if (error instanceof StorageContractError && error.code === 'CONFLICT') return false; throw error; }
}
export function executeSessionEffect(db: DB, actor: Actor, command: Command, operationId: string) {
  const sessionId = command.input.sessionId;
  if (command.name === 'session.prepareUnarchive') {
    const current = source(db, actor, sessionId);
    if(command.input.expectedThreadId!==undefined&&command.input.expectedThreadId!==current.row.codex_thread_id)deny('CONFLICT');
    const existing = db.get("SELECT * FROM _relay_external_operations WHERE kind='unarchive' AND session_id=? AND phase IN ('prepared','dispatched')", [sessionId]);
    if (existing) {
      if (existing.actor_user_id !== actor.id || existing.source_digest !== current.fingerprint) deny('CONFLICT');
      return { sessionId, externalOperationId: String(existing.id), threadId: String(existing.external_id) };
    }
    const now = Date.now();
    db.run(`INSERT INTO _relay_external_operations(id,kind,actor_user_id,session_id,source_digest,external_id,phase,created_at,updated_at)
      VALUES(?,'unarchive',?,?,?,?,'prepared',?,?)`, [operationId, actor.id, sessionId, current.fingerprint, current.row.codex_thread_id, now, now]);
    if (actor.role === 'admin') appendAdminAuditEventInDatabase(db, { actorUserId: actor.id, action: 'session.unarchive', resourceType: 'session',
      resourceId: sessionId, ownerUserId: String(current.row.owner_user_id), result: 'started', occurredAt: now }, randomUUID);
    return { sessionId, externalOperationId: operationId, threadId: String(current.row.codex_thread_id) };
  }
  const op = operation(db, actor, sessionId, command.input.externalOperationId);
  if (op.phase === 'applied') return command.name === 'session.claimUnarchive'
    ? { sessionId, externalOperationId: String(op.id), claimed: false, alreadyApplied: true }
    : { sessionId, externalOperationId: String(op.id), threadId: String(op.external_id) };
  const current = source(db, actor, sessionId);
  if (current.fingerprint !== op.source_digest) deny('CONFLICT');
  if (command.name === 'session.claimUnarchive') {
    const claimed = op.phase === 'prepared';
    if (claimed) db.run("UPDATE _relay_external_operations SET phase='dispatched',updated_at=? WHERE id=?", [Date.now(), op.id]);
    return { sessionId, externalOperationId: String(op.id), claimed, alreadyApplied: false };
  }
  if (op.phase !== 'dispatched') deny('CONFLICT');
  db.run('UPDATE sessions SET codex_archived=0,codex_archived_for_trash=0 WHERE id=?', [sessionId]);
  db.run("UPDATE _relay_external_operations SET phase='applied',updated_at=? WHERE id=?", [Date.now(), op.id]);
  // Invalidate every provider snapshot begun before this confirmed external action.
  const barrier = beginArchiveSnapshot(db).version;
  db.run("UPDATE _relay_storage_observations SET latest_applied=?,snapshot_digest=? WHERE scope='codex-archive'", [barrier,
    createHash('sha256').update('unarchive:'+String(op.id)).digest('hex')]);
  if (actor.role === 'admin') appendAdminAuditEventInDatabase(db, { actorUserId: actor.id, action: 'session.unarchive', resourceType: 'session',
    resourceId: sessionId, ownerUserId: String(current.row.owner_user_id), result: 'succeeded', occurredAt: Date.now() }, randomUUID);
  return { sessionId, externalOperationId: String(op.id), threadId: String(op.external_id) };
}
