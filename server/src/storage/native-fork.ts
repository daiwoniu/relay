import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, StorageContractError } from './command-boundary.js';
import type { CoreCommand, CoreCommandName, CoreStoragePort } from './contracts.js';
import type { nativeQueries } from './native-queries.js';
import { requireManagedResource, createOwnedProject } from './native-resource-writes.js';
import { normalizeProjectPathForOwnership } from '../db/multi-account.js';
import { parseMessageMetadata, serializeMessageMetadata } from '../message-metadata.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';

type DB = ReturnType<typeof nativeQueries>;
type Actor = { id: string; role: string };
const names = ['session.prepareFork','session.claimFork','session.acknowledgeFork','session.finishFork'] as const;
type Command = Extract<CoreCommand, { name: typeof names[number] }>;
export function isForkCommand(name: string): name is typeof names[number] { return (names as readonly string[]).includes(name); }
function deny(code: ConstructorParameters<typeof StorageContractError>[0]): never { throw new StorageContractError(code); }
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function collect(db: DB, actor: Actor, sessionId: string, anchorId: string | null, visit?: (message: any, ordinal: number) => void) {
  requireManagedResource(db, actor, 'session', sessionId);
  const source = db.get(`SELECT id,title,owner_user_id,project_id,engine,engine_bound,engine_session_id,codex_thread_id,codex_archived,
    status,message_revision,selected_model_id,selected_reasoning_effort,selected_service_tier FROM sessions WHERE id=?`, [sessionId])!;
  const project = db.get('SELECT id,path,name,owner_user_id FROM projects WHERE id=? AND deleted_at IS NULL', [source.project_id]);
  if (!project || !source.engine_bound || !['codex','zcode'].includes(String(source.engine))) deny('CONFLICT');
  const threadId = source.engine === 'codex' ? source.codex_thread_id : source.engine_session_id;
  if (!threadId || source.engine === 'codex' && source.codex_archived) deny('CONFLICT');
  if (!anchorId && !['idle','completed','failed','stopped','interrupted'].includes(String(source.status))) deny('CONFLICT');
  const anchor = anchorId ? db.get(`SELECT id,role,turn_id,stopped,created_at,
    coalesce(length(CAST(content AS BLOB)),0)+coalesce(length(CAST(items AS BLOB)),0)+coalesce(length(CAST(metadata AS BLOB)),0) AS bytes
    FROM messages WHERE id=? AND session_id=?`, [anchorId, sessionId]) : null;
  if (anchor && Number(anchor.bytes)>7*1024*1024) deny('PAYLOAD_TOO_LARGE');
  const anchorMetadata = anchor ? db.get('SELECT metadata FROM messages WHERE id=? AND session_id=?', [anchorId, sessionId]) : null;
  if (anchorId && (!anchor || anchor.role !== 'assistant' || anchor.stopped || !String(anchor.turn_id ?? '').trim()
    || ![undefined,'completed'].includes(parseMessageMetadata(anchorMetadata?.metadata as string | null).outcome))) deny('CONFLICT');
  const where = anchor ? 'session_id=? AND (created_at<? OR (created_at=? AND id<=?))' : 'session_id=?';
  const params = anchor ? [sessionId, anchor.created_at, anchor.created_at, anchor.id] : [sessionId];
  const size = db.get(`SELECT count(*) AS count,max(coalesce(length(CAST(content AS BLOB)),0)+coalesce(length(CAST(items AS BLOB)),0)+coalesce(length(CAST(metadata AS BLOB)),0)) AS bytes FROM messages WHERE ${where}`, params as any);
  if (!size?.count) deny('CONFLICT');
  if (Number(size.count) > 20000 || Number(size.bytes) > 7*1024*1024) deny('PAYLOAD_TOO_LARGE');
  const { status, message_revision, ...stableSource } = source;
  const hash = createHash('sha256').update(canonicalJson({ source: stableSource, project, anchorId,
    ...(anchorId ? {} : { status, message_revision }) }));
  let count = 0, users = 0;
  for (const message of db.iterate(`SELECT id,turn_id,role,content,phase,items,metadata,created_at,duration,stopped FROM messages WHERE ${where} ORDER BY created_at,id`, params as any)) {
    hash.update('\n').update(canonicalJson(message)); if (message.role === 'user') users++;
    visit?.(message, count++);
  }
  if (anchor && source.engine === 'zcode' && !users) deny('CONFLICT');
  return { source, project, fingerprint: hash.digest('hex'), threadId: String(threadId), anchorTurnId: anchor ? String(anchor.turn_id) : null,
    turnIndex: anchor ? users-1 : null, count };
}
function operation(db: DB, actor: Actor, sessionId: string, id: string) {
  const op = db.get(`SELECT e.*,f.plan_json,f.child_id,f.claim_token FROM _relay_external_operations e JOIN _relay_forks f ON f.id=e.id
    WHERE e.id=? AND e.kind='fork' AND e.session_id=?`, [id, sessionId]);
  if (!op || op.actor_user_id !== actor.id) deny('FORBIDDEN');
  requireManagedResource(db, actor, 'session', sessionId);
  const plan = JSON.parse(String(op.plan_json));
  if (op.phase !== 'applied' && collect(db, actor, sessionId, plan.messageId).fingerprint !== op.source_digest) deny('CONFLICT');
  return { op, plan };
}
export function authorizeForkReceipt(db: DB, actor: Actor, name: CoreCommandName, value: any) {
  if (!isForkCommand(name)) deny('INVALID_ARGUMENT'); operation(db, actor, value.sessionId, value.externalOperationId);
}
/** Save a proven external result even if source or user access changed during RPC; never creates a platform resource. */
export function recordForkOutcome(db: DB, input: Extract<Command,{name:'session.acknowledgeFork'}>['input']) {
  const op = db.get(`SELECT e.phase,e.external_id,f.claim_token,f.child_id,f.plan_json FROM _relay_external_operations e JOIN _relay_forks f ON f.id=e.id
    WHERE e.id=? AND e.kind='fork' AND e.session_id=?`, [input.externalOperationId, input.sessionId]);
  if (!op || op.phase === 'prepared' || op.claim_token !== input.claimToken || op.external_id === input.childId
    || op.child_id && op.child_id !== input.childId) deny('CONFLICT');
  const plan = JSON.parse(String(op.plan_json));
  if (!op.child_id && (db.get('SELECT id FROM sessions WHERE engine=? AND (engine_session_id=? OR codex_thread_id=?)', [plan.engine, input.childId, input.childId])
    || db.get("SELECT id FROM _relay_forks WHERE child_id=? AND json_extract(plan_json,'$.engine')=? AND id<>?", [input.childId, plan.engine, input.externalOperationId]))) deny('CONFLICT');
  if (!op.child_id) db.run('UPDATE _relay_forks SET child_id=? WHERE id=?', [input.childId, input.externalOperationId]);
  return { sessionId: input.sessionId, externalOperationId: input.externalOperationId, childId: input.childId };
}
export function readForkPlan(db: DB, actor: Actor, request: Parameters<CoreStoragePort['readForkPlan']>[0]): Awaited<ReturnType<CoreStoragePort['readForkPlan']>> {
  const { op, plan } = operation(db, actor, request.sessionId, request.externalOperationId);
  const rows = db.all(`SELECT f.ordinal,f.source_id,f.target_id FROM _relay_fork_messages f JOIN messages m ON m.id=f.source_id
    WHERE f.operation_id=? AND f.ordinal>? ORDER BY f.ordinal LIMIT 21`, [op.id, request.after]);
  const page = rows.slice(0,20);
  const copies = page.flatMap((row) => {
    // A page may contain twenty individually large process fields. Load one metadata record at a time.
    const message = db.get('SELECT metadata FROM messages WHERE id=?', [row.source_id]);
    if (!message) deny('CONFLICT');
    const attachments = parseMessageMetadata(message.metadata as string | null).attachments?.filter((a) => a.kind === 'uploaded_file') ?? [];
    return attachments.length ? [{ sourceMessageId: String(row.source_id), targetMessageId: String(row.target_id), attachmentIds: attachments.map((a) => a.id) }] : [];
  });
  const value = { sessionId: request.sessionId, externalOperationId: String(op.id), forkedSessionId: plan.forkedSessionId,
    targetProjectId: plan.targetProjectId, sourceProjectId: plan.sourceProjectId, sourceUserId: plan.sourceUserId,
    engine: plan.engine, threadId: String(op.external_id), projectRoot: plan.projectRoot, anchorTurnId: plan.anchorTurnId, turnIndex: plan.turnIndex,
    phase: op.phase, childId: op.child_id ?? null, claimToken: op.claim_token ?? null, copies, next: rows.length > 20 ? Number(page.at(-1)!.ordinal) : null };
  canonicalJson(value, 1024*1024); return value as Awaited<ReturnType<CoreStoragePort['readForkPlan']>>;
}
export function executeFork(db: DB, actor: Actor, command: Command, operationId: string) {
  const { sessionId } = command.input;
  if (command.name === 'session.prepareFork') {
    const current = collect(db, actor, sessionId, command.input.messageId);
    const pending = db.get("SELECT id,source_digest,actor_user_id FROM _relay_external_operations WHERE kind='fork' AND session_id=? AND phase IN ('prepared','dispatched')", [sessionId]);
    if (pending) {
      if (pending.actor_user_id !== actor.id || pending.source_digest !== current.fingerprint) deny('CONFLICT');
      const { plan } = operation(db, actor, sessionId, String(pending.id));
      return { sessionId, externalOperationId: String(pending.id), forkedSessionId: plan.forkedSessionId };
    }
    const normalized = normalizeProjectPathForOwnership(String(current.project.path));
    const ownProject = current.project.owner_user_id === actor.id ? current.project : db.get('SELECT id,deleted_at FROM projects WHERE owner_user_id=? AND normalized_path=?', [actor.id, normalized]);
    if (ownProject && ownProject.deleted_at) deny('CONFLICT');
    const now = Date.now(), plan = { messageId: command.input.messageId, forkedSessionId: randomUUID(), targetProjectId: ownProject?.id ?? randomUUID(),
      sourceProjectId: current.project.id, sourceUserId: current.source.owner_user_id, engine: current.source.engine,
      projectRoot: current.project.path, projectName: current.project.name, anchorTurnId: current.anchorTurnId, turnIndex: current.turnIndex };
    db.run(`INSERT INTO _relay_external_operations VALUES(?,'fork',?,?,?,?,'prepared',?,?)`, [operationId, actor.id, sessionId, current.fingerprint, current.threadId, now, now]);
    db.run('INSERT INTO _relay_forks(id,plan_json,child_id,claim_token) VALUES(?,?,NULL,NULL)', [operationId, canonicalJson(plan)]);
    collect(db, actor, sessionId, command.input.messageId, (m, ordinal) => db.run('INSERT INTO _relay_fork_messages(operation_id,ordinal,source_id,target_id,source_digest) VALUES(?,?,?,?,?)', [operationId, ordinal, m.id, randomUUID(), digest(m)]));
    if (actor.role === 'admin') appendAdminAuditEventInDatabase(db, { actorUserId: actor.id, ownerUserId: String(current.source.owner_user_id), action: 'session.fork_from', resourceType: 'session', resourceId: sessionId, result: 'started', occurredAt: now }, randomUUID);
    return { sessionId, externalOperationId: operationId, forkedSessionId: plan.forkedSessionId };
  }
  const { op, plan } = operation(db, actor, sessionId, command.input.externalOperationId);
  if (command.name === 'session.claimFork') {
    const claimed = op.phase === 'prepared';
    if (claimed) {
      db.run("UPDATE _relay_external_operations SET phase='dispatched',updated_at=? WHERE id=?", [Date.now(), op.id]);
      db.run('UPDATE _relay_forks SET claim_token=? WHERE id=?', [operationId, op.id]);
    }
    return { sessionId, externalOperationId: String(op.id), claimed, claimToken: claimed ? operationId : null };
  }
  if (command.name === 'session.acknowledgeFork') {
    return recordForkOutcome(db, command.input);
  }
  if (op.phase === 'applied') return { sessionId, externalOperationId: String(op.id), forkedSessionId: plan.forkedSessionId, projectId: plan.targetProjectId };
  if (op.phase !== 'dispatched' || !op.child_id) deny('CONFLICT');
  const current = collect(db, actor, sessionId, plan.messageId), now = Date.now();
  const existingProject = db.get('SELECT id,owner_user_id,path,deleted_at FROM projects WHERE id=?', [plan.targetProjectId]);
  if (existingProject && (existingProject.owner_user_id !== actor.id || existingProject.deleted_at !== null
    || normalizeProjectPathForOwnership(String(existingProject.path)) !== normalizeProjectPathForOwnership(plan.projectRoot))) deny('CONFLICT');
  const ownProject = existingProject ? { projectId: String(existingProject.id) }
    : createOwnedProject(db, actor.id, plan.targetProjectId, plan.projectRoot, plan.projectName, now);
  if (ownProject.projectId !== plan.targetProjectId) deny('CONFLICT');
  const s = current.source, title = `${String(s.title).slice(0,195)}（新会话）`;
  db.run(`INSERT INTO sessions(id,title,title_manually_set,created_at,updated_at,pinned,archived,project_id,owner_user_id,engine,engine_bound,engine_session_id,codex_thread_id,codex_archived,status,message_revision,context_compaction_count,engine_preferences_revision,selected_model_id,selected_reasoning_effort,selected_service_tier,engine_metadata)
    VALUES(?,?,1,?,?,0,0,?,?,?,1,?,?,0,'idle',0,0,0,?,?,?,?)`, [plan.forkedSessionId, title, now, now, plan.targetProjectId, actor.id, s.engine, op.child_id,
      s.engine === 'codex' ? op.child_id : null, s.selected_model_id, s.selected_reasoning_effort, s.selected_service_tier,
      canonicalJson({ forkedFromSessionId: sessionId, forkedFromThreadId: s.codex_thread_id })]);
  const uploads = new Map(command.input.uploads.map((u) => [u.sourceMessageId, u.attachments]));
  let consumed = 0;
  for (const row of db.iterate(`SELECT f.ordinal,f.target_id,f.source_digest,m.id,m.turn_id,m.role,m.content,m.phase,m.items,m.metadata,m.created_at,m.duration,m.stopped
    FROM _relay_fork_messages f JOIN messages m ON m.id=f.source_id WHERE f.operation_id=? ORDER BY f.ordinal`, [op.id])) {
    const { ordinal, target_id, source_digest, ...message } = row;
    if (digest(message) !== source_digest) deny('CONFLICT');
    const metadata = parseMessageMetadata(message.metadata as string | null), oldAttachments = metadata.attachments ?? [];
    const incoming = uploads.get(String(message.id)); let index = 0;
    const attachments = oldAttachments.map((a) => {
      if (a.kind !== 'uploaded_file') return { ...a, id: randomUUID() };
      const copy = incoming?.[index++];
      const expected = path.join(plan.projectRoot, '.relay_upload', 'messages', String(target_id), path.basename(a.path));
      if (!copy || copy.name !== a.name || copy.size !== a.size || copy.mimeType !== a.mimeType || path.resolve(copy.path) !== path.resolve(expected) || copy.id === a.id) deny('CONFLICT');
      return copy;
    });
    if (index) { if (incoming?.length !== index) deny('CONFLICT'); consumed++; }
    else if (incoming) deny('CONFLICT');
    const serialized = serializeMessageMetadata({ ...metadata, ...(attachments.length ? { attachments } : {}) });
    db.run('INSERT INTO messages(id,session_id,turn_id,role,content,phase,items,metadata,created_at,duration,stopped) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [target_id, plan.forkedSessionId, message.turn_id, message.role, message.content, message.phase, message.items, serialized, now+Number(ordinal)+1, message.duration, message.stopped] as any);
  }
  if (consumed !== uploads.size) deny('CONFLICT');
  db.run("UPDATE _relay_external_operations SET phase='applied',updated_at=? WHERE id=?", [now, op.id]);
  if (actor.role === 'admin') appendAdminAuditEventInDatabase(db, { actorUserId: actor.id, ownerUserId: String(s.owner_user_id), action: 'session.fork_from', resourceType: 'session', resourceId: sessionId, result: 'succeeded', occurredAt: now }, randomUUID);
  return { sessionId, externalOperationId: String(op.id), forkedSessionId: plan.forkedSessionId, projectId: plan.targetProjectId };
}
