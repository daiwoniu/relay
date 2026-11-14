import { createHash } from 'node:crypto';
import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,SoftDeleteJob,StoragePrincipal } from './contracts.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
import { beginArchiveSnapshot } from './native-archive.js';
type DB=ReturnType<typeof nativeQueries>;type Actor={id:string;role:string}|null;
const names=['trash.prepareSoftDelete','trash.claimTrashArchive','trash.confirmTrashArchive','trash.commitSoftDelete','trash.abandonSoftDelete','trash.beginSoftDeleteCancel','trash.claimTrashRestore','trash.confirmTrashRestore','trash.finishSoftDeleteCancel'] as const;
type Name=typeof names[number];
export function isSoftDeleteCommand(name:string):name is Name{return(names as readonly string[]).includes(name);}
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
function owned(actor:Exclude<Actor,null>,owner:unknown){if(typeof owner!=='string'||!owner||actor.id!==owner&&actor.role!=='admin')deny('FORBIDDEN');}
function audit(db:DB,actor:Actor,job:Record<string,unknown>,result:'started'|'succeeded'|'failed'){
  if(!actor||actor.role!=='admin'||actor.id===job.owner_user_id)return;
  const id='soft-delete:'+createHash('sha256').update(canonicalJson([job.id,actor.id,result])).digest('hex');
  if(db.get('SELECT 1 FROM admin_audit_events WHERE id=?',[id]))return;
  appendAdminAuditEventInDatabase(db,{actorUserId:actor.id,action:job.kind==='project'?'project.delete':'session.delete',resourceType:job.kind==='project'?'project':'session',
    resourceId:String(job.resource_id),ownerUserId:String(job.owner_user_id),result,occurredAt:Date.now()},()=>id);
}
const columns=['id','owner_user_id','project_id','deleted_at','status','active_attempt_id','engine','engine_bound','codex_thread_id','engine_session_id','message_revision','codex_archived','codex_archived_for_trash','updated_at','title'];
/** No bodies, filesystem access or provider calls. The caller holds the business/read transaction. */
function source(db:DB,actor:Exclude<Actor,null>,kind:'project'|'session',id:string){
  let projectId=id;
  if(kind==='session'){const session=db.get('SELECT owner_user_id,project_id FROM sessions WHERE id=? AND deleted_at IS NULL',[id]);if(!session)deny('NOT_FOUND');owned(actor,session.owner_user_id);projectId=String(session.project_id);}
  const project=db.get('SELECT id,name,path,normalized_path,owner_user_id,deleted_at,is_system,deletion_protected,updated_at FROM projects WHERE id=? AND deleted_at IS NULL',[projectId]);
  if(!project?.owner_user_id)deny('NOT_FOUND');
  if(kind==='project'){
    owned(actor,project.owner_user_id);
    if(project.is_system||project.deletion_protected||db.get('SELECT 1 FROM users WHERE default_project_id=? LIMIT 1',[id]))deny('CONFLICT');
  }
  const selection=kind==='project'?'SELECT id FROM sessions WHERE project_id=?':'SELECT id FROM sessions WHERE id=?';
  const where=`session_id IN (${selection})`,sizes=columns.map(c=>`coalesce(length(CAST(${c} AS BLOB)),0)`).join('+');
  const budget=db.get(`SELECT count(*) AS n,coalesce(sum(${sizes}),0) AS bytes,coalesce(max(${sizes}),0) AS largest FROM sessions WHERE id IN (${selection})`,[id])!;
  if(Number(budget.n)>1000||Number(budget.bytes)>2*1024*1024||Number(budget.largest)>16*1024)deny('PAYLOAD_TOO_LARGE');
  const rows=db.all(`SELECT ${columns.join(',')} FROM sessions WHERE id IN (${selection}) ORDER BY id`,[id]);
  if(rows.some(r=>!r.owner_user_id||r.active_attempt_id||!['idle','completed','failed','stopped','interrupted'].includes(String(r.status))))deny('CONFLICT');
  if(db.get(`SELECT 1 FROM engine_resource_leases WHERE ${where} LIMIT 1`,[id])
    ||db.get(`SELECT 1 FROM engine_queue_entries WHERE ${where} AND state IN ('queued','claimed','running') LIMIT 1`,[id])
    ||db.get(`SELECT 1 FROM session_followups WHERE ${where} AND state IN ('received','steering','queued','dispatching','uncertain') LIMIT 1`,[id])
    ||db.get(`SELECT 1 FROM _relay_external_operations WHERE ${where} AND phase IN ('prepared','dispatched') LIMIT 1`,[id]))deny('CONFLICT');
  const activeThreads=`SELECT codex_thread_id FROM sessions WHERE id IN (${selection}) AND deleted_at IS NULL AND engine='codex' AND engine_bound=1 AND codex_thread_id IS NOT NULL`;
  if(db.get(`SELECT 1 FROM sessions WHERE engine='codex' AND (codex_thread_id IN (${activeThreads}) OR engine_session_id IN (${activeThreads})) AND id NOT IN (${selection}) LIMIT 1`,[id,id,id]))deny('CONFLICT');
  if(rows.some(r=>r.codex_thread_id!==null&&(typeof r.codex_thread_id!=='string'||Buffer.byteLength(r.codex_thread_id)>256)))deny('CONFLICT');
  if(rows.some(r=>r.engine==='codex'&&r.engine_bound===1&&r.engine_session_id&&r.engine_session_id!==r.codex_thread_id))deny('CONFLICT');
  const hash=createHash('sha256');hash.update(canonicalJson({kind,id,project},64*1024));
  for(const row of rows)hash.update('\n'+canonicalJson(row,32*1024));
  return{project,rows,digest:hash.digest('hex'),ownerUserId:String(kind==='project'?project.owner_user_id:rows[0]!.owner_user_id)};
}
export function createSoftDeleteSchema(db:DB){db.exec(`CREATE TABLE _relay_soft_delete_jobs(
  id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('project','session')),resource_id TEXT NOT NULL,project_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,source_digest TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','cancelling','committed','abandoned')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE INDEX _relay_soft_project ON _relay_soft_delete_jobs(project_id,phase);
  CREATE INDEX _relay_soft_pending ON _relay_soft_delete_jobs(id) WHERE phase IN ('prepared','cancelling');
  CREATE TABLE _relay_soft_delete_sessions(job_id TEXT NOT NULL REFERENCES _relay_soft_delete_jobs(id),session_id TEXT NOT NULL,
    was_deleted INTEGER NOT NULL,thread_id TEXT,prior_restore INTEGER NOT NULL,PRIMARY KEY(job_id,session_id));
  CREATE INDEX _relay_soft_session ON _relay_soft_delete_sessions(session_id,job_id);
  CREATE TABLE _relay_trash_archives(job_id TEXT NOT NULL REFERENCES _relay_soft_delete_jobs(id),thread_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','confirmed')),restore_required INTEGER,evidence TEXT,dispatch_token_hash TEXT,dispatch_writer_nonce TEXT,
    PRIMARY KEY(job_id,thread_id));
  CREATE TABLE _relay_trash_compensations(job_id TEXT NOT NULL REFERENCES _relay_soft_delete_jobs(id),thread_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','confirmed')),dispatch_token_hash TEXT,dispatch_writer_nonce TEXT,
    PRIMARY KEY(job_id,thread_id));`);}
function header(db:DB,id:string){const row=db.get('SELECT * FROM _relay_soft_delete_jobs WHERE id=?',[id]);if(!row)deny('NOT_FOUND');return row;}
export function authorizeSoftDeleteJob(db:DB,actor:Actor,principal:StoragePrincipal,id:string){
  const job=header(db,id);
  if(principal.kind==='system'&&principal.purpose==='maintenance')return job;
  if(!actor||principal.kind!=='user'||actor.id!==job.actor_user_id&&actor.role!=='admin')deny('FORBIDDEN');
  const current=job.kind==='project'?db.get('SELECT owner_user_id FROM projects WHERE id=?',[job.resource_id]):db.get('SELECT owner_user_id FROM sessions WHERE id=?',[job.resource_id]);
  if(current)owned(actor,current.owner_user_id);else if(job.phase!=='committed')deny('NOT_FOUND');else owned(actor,job.owner_user_id);
  return job;
}
export function readSoftDeleteJob(db:DB,id:string):SoftDeleteJob|null{
  const job=db.get('SELECT * FROM _relay_soft_delete_jobs WHERE id=?',[id]);if(!job)return null;
  const rows=db.all('SELECT session_id,was_deleted,thread_id FROM _relay_soft_delete_sessions WHERE job_id=? ORDER BY session_id LIMIT 1001',[id]);
  const effects=db.all('SELECT thread_id,phase,restore_required,evidence FROM _relay_trash_archives WHERE job_id=? ORDER BY thread_id LIMIT 1001',[id]);
  const compensations=db.all('SELECT thread_id,phase FROM _relay_trash_compensations WHERE job_id=? ORDER BY thread_id LIMIT 1001',[id]);
  if(rows.length>1000||effects.length>1000||compensations.length>1000)deny('PAYLOAD_TOO_LARGE');
  return{jobId:id,kind:job.kind,resourceId:String(job.resource_id),projectId:String(job.project_id),ownerUserId:String(job.owner_user_id),phase:job.phase,
    targets:rows.map(r=>({sessionId:String(r.session_id),alreadyDeleted:r.was_deleted===1,threadId:r.thread_id})),
    archives:effects.map(r=>({threadId:String(r.thread_id),phase:r.phase,restoreOnRecovery:r.restore_required===null?null:r.restore_required===1,evidence:r.evidence})),
    compensations:compensations.map(r=>({threadId:String(r.thread_id),phase:r.phase}))};
}
function current(db:DB,job:Record<string,any>,actor:Actor){
  const now=source(db,actor??{id:String(job.owner_user_id),role:'admin'},job.kind,String(job.resource_id));
  if(now.digest!==job.source_digest)deny('CONFLICT');return now;
}
export function checkTrashArchiveDispatch(db:DB,actor:Exclude<Actor,null>,principal:StoragePrincipal,input:{jobId:string;threadId:string;claimToken:string},writerNonce:string){
  const job=authorizeSoftDeleteJob(db,actor,principal,input.jobId);if(job.phase!=='prepared')return false;
  const effect=db.get('SELECT phase,dispatch_token_hash,dispatch_writer_nonce FROM _relay_trash_archives WHERE job_id=? AND thread_id=?',[input.jobId,input.threadId]);
  if(effect?.phase!=='dispatched'||effect.dispatch_writer_nonce!==writerNonce||effect.dispatch_token_hash!==createHash('sha256').update(input.claimToken).digest('hex'))return false;
  try{current(db,job,actor);return true;}catch(e){if(e instanceof StorageContractError&&e.code==='CONFLICT')return false;throw e;}
}
export function checkTrashRestoreDispatch(db:DB,actor:Actor,principal:StoragePrincipal,input:{jobId:string;threadId:string;claimToken:string},writerNonce:string){
  const job=authorizeSoftDeleteJob(db,actor,principal,input.jobId);if(job.phase!=='cancelling')return false;
  const effect=db.get('SELECT * FROM _relay_trash_compensations WHERE job_id=? AND thread_id=?',[input.jobId,input.threadId]);
  if(effect?.phase!=='dispatched'||effect.dispatch_writer_nonce!==writerNonce||effect.dispatch_token_hash!==createHash('sha256').update(input.claimToken).digest('hex'))return false;
  try{current(db,job,actor);return true;}catch(e){if(e instanceof StorageContractError&&e.code==='CONFLICT')return false;throw e;}
}
export function checkSoftDeleteClose(db:DB,actor:Exclude<Actor,null>,principal:StoragePrincipal,input:{jobId:string;sessionId:string;threadId:string}){
  const job=authorizeSoftDeleteJob(db,actor,principal,input.jobId);if(job.phase!=='committed')return false;
  const row=db.get(`SELECT s.* FROM sessions s JOIN _relay_soft_delete_sessions t ON t.session_id=s.id
    WHERE t.job_id=? AND t.session_id=? AND t.was_deleted=0 AND t.thread_id=?`,[input.jobId,input.sessionId,input.threadId]);
  if(!row||row.owner_user_id!==job.owner_user_id||row.project_id!==job.project_id||row.deleted_at===null||row.engine!=='codex'||row.engine_bound!==1
    ||row.codex_thread_id!==input.threadId||row.engine_session_id&&row.engine_session_id!==input.threadId||row.active_attempt_id
    ||!['idle','completed','failed','stopped','interrupted'].includes(String(row.status)))return false;
  for(const sql of ['SELECT 1 FROM engine_resource_leases WHERE session_id=?',
    "SELECT 1 FROM engine_queue_entries WHERE session_id=? AND state IN ('queued','claimed','running')",
    "SELECT 1 FROM session_followups WHERE session_id=? AND state IN ('received','steering','queued','dispatching','uncertain')",
    "SELECT 1 FROM _relay_external_operations WHERE session_id=? AND phase IN ('prepared','dispatched')"])
    if(db.get(sql+' LIMIT 1',[input.sessionId]))return false;
  return true;
}
export function executeSoftDelete(db:DB,actor:Actor,principal:StoragePrincipal,command:Extract<CoreCommand,{name:Name}>,writerNonce:string){
  const now=Date.now();
  if(command.name==='trash.prepareSoftDelete'){
    if(!actor||principal.kind!=='user')deny('FORBIDDEN');const input=command.input,found=source(db,actor,input.kind,input.resourceId);
    if(db.get('SELECT 1 FROM _relay_soft_delete_jobs WHERE id=?',[input.jobId]))deny('CONFLICT');
    if(db.get("SELECT 1 FROM _relay_soft_delete_jobs WHERE project_id=? AND phase IN ('prepared','cancelling') AND (kind='project' OR ?='project' OR resource_id=?) LIMIT 1",[found.project.id,input.kind,input.resourceId]))deny('CONFLICT');
    db.run("INSERT INTO _relay_soft_delete_jobs VALUES(?,?,?,?,?,?,?,'prepared',?,?)",[input.jobId,input.kind,input.resourceId,found.project.id,found.ownerUserId,actor.id,found.digest,now,now]);
    for(const row of found.rows){const thread=row.deleted_at===null&&row.engine==='codex'&&row.engine_bound===1&&row.codex_thread_id?String(row.codex_thread_id):null;
      db.run('INSERT INTO _relay_soft_delete_sessions VALUES(?,?,?,?,?)',[input.jobId,row.id,Number(row.deleted_at!==null),thread,Number(row.codex_archived_for_trash===1)]);
      if(thread&&input.archiveCodex!==false)db.run("INSERT OR IGNORE INTO _relay_trash_archives VALUES(?,?,'prepared',NULL,NULL,NULL,NULL)",[input.jobId,thread]);
    }
    audit(db,actor,header(db,input.jobId),'started');
    return readSoftDeleteJob(db,input.jobId)!;
  }
  const job=authorizeSoftDeleteJob(db,actor,principal,command.input.jobId),jobId=String(job.id);
  if(command.name==='trash.beginSoftDeleteCancel'){
    if(!actor||principal.kind!=='user')deny('FORBIDDEN');
    if(job.phase==='abandoned'||job.phase==='cancelling')return readSoftDeleteJob(db,jobId)!;
    if(job.phase!=='prepared')deny('CONFLICT');current(db,job,actor);
    // A positive observation cannot prove that the original provider request has settled or owns this archive.
    if(db.get("SELECT 1 FROM _relay_trash_archives WHERE job_id=? AND (phase='dispatched' OR (restore_required=1 AND evidence!='provider-reply')) LIMIT 1",[jobId]))deny('CONFLICT');
    db.run("INSERT INTO _relay_trash_compensations SELECT job_id,thread_id,'prepared',NULL,NULL FROM _relay_trash_archives WHERE job_id=? AND restore_required=1",[jobId]);
    db.run("UPDATE _relay_soft_delete_jobs SET phase='cancelling',updated_at=? WHERE id=?",[now,jobId]);return readSoftDeleteJob(db,jobId)!;
  }
  if(command.name==='trash.claimTrashRestore'||command.name==='trash.confirmTrashRestore'||command.name==='trash.finishSoftDeleteCancel'){
    if(job.phase==='abandoned'&&command.name==='trash.finishSoftDeleteCancel')return readSoftDeleteJob(db,jobId)!;
    if(job.phase!=='cancelling')deny('CONFLICT');current(db,job,actor);
    if(command.name==='trash.finishSoftDeleteCancel'){
      if(db.get("SELECT 1 FROM _relay_trash_compensations WHERE job_id=? AND phase!='confirmed' LIMIT 1",[jobId]))deny('CONFLICT');
      const barrier=beginArchiveSnapshot(db).version;db.run("UPDATE _relay_storage_observations SET latest_applied=?,snapshot_digest=? WHERE scope='codex-archive'",[barrier,createHash('sha256').update('cancel-soft-delete:'+jobId).digest('hex')]);
      audit(db,actor,job,'failed');db.run("UPDATE _relay_soft_delete_jobs SET phase='abandoned',updated_at=? WHERE id=?",[now,jobId]);return readSoftDeleteJob(db,jobId)!;
    }
    const input=command.input,effect=db.get('SELECT * FROM _relay_trash_compensations WHERE job_id=? AND thread_id=?',[jobId,input.threadId]);if(!effect)deny('NOT_FOUND');
    if(command.name==='trash.claimTrashRestore'){
      if(effect.phase!=='prepared')return{jobId,threadId:input.threadId,claimed:false,alreadyConfirmed:effect.phase==='confirmed',claimToken:null};
      if(command.input.observedUnarchived){db.run("UPDATE _relay_trash_compensations SET phase='confirmed' WHERE job_id=? AND thread_id=?",[jobId,input.threadId]);return{jobId,threadId:input.threadId,claimed:false,alreadyConfirmed:true,claimToken:null};}
      db.run("UPDATE _relay_trash_compensations SET phase='dispatched',dispatch_token_hash=?,dispatch_writer_nonce=? WHERE job_id=? AND thread_id=?",[createHash('sha256').update(command.input.claimToken).digest('hex'),writerNonce,jobId,input.threadId]);
      return{jobId,threadId:input.threadId,claimed:true,alreadyConfirmed:false,claimToken:command.input.claimToken};
    }
    if(effect.phase==='prepared'||effect.dispatch_writer_nonce!==writerNonce||effect.dispatch_token_hash!==createHash('sha256').update(command.input.claimToken).digest('hex'))deny('CONFLICT');
    db.run("UPDATE _relay_trash_compensations SET phase='confirmed' WHERE job_id=? AND thread_id=?",[jobId,input.threadId]);return{jobId,threadId:input.threadId,confirmed:true as const};
  }
  if(command.name==='trash.abandonSoftDelete'){
    if(job.phase==='cancelling')deny('CONFLICT');
    if(job.phase==='committed')deny('CONFLICT');
    if(db.get("SELECT 1 FROM _relay_trash_archives WHERE job_id=? AND (phase='dispatched' OR restore_required=1) LIMIT 1",[jobId]))deny('CONFLICT');
    audit(db,actor,job,'failed');
    db.run("UPDATE _relay_soft_delete_jobs SET phase='abandoned',updated_at=? WHERE id=?",[now,jobId]);return readSoftDeleteJob(db,jobId)!;
  }
  if(job.phase==='abandoned')deny('CONFLICT');
  if(job.phase==='cancelling')deny('CONFLICT');
  if(command.name==='trash.claimTrashArchive'||command.name==='trash.confirmTrashArchive'){
    const input=command.input,effect=db.get('SELECT * FROM _relay_trash_archives WHERE job_id=? AND thread_id=?',[jobId,input.threadId]);if(!effect)deny('NOT_FOUND');
    if(job.phase==='prepared')current(db,job,actor);
    if(command.name==='trash.claimTrashArchive'){
      if(!actor||principal.kind!=='user')deny('FORBIDDEN');
      if(effect.phase!=='prepared')return{jobId,threadId:input.threadId,claimed:false,alreadyConfirmed:effect.phase==='confirmed',claimToken:null};
      audit(db,actor,job,'started');
      if(command.input.observedArchived){db.run("UPDATE _relay_trash_archives SET phase='confirmed',restore_required=0,evidence='already-archived' WHERE job_id=? AND thread_id=?",[jobId,input.threadId]);
        return{jobId,threadId:input.threadId,claimed:false,alreadyConfirmed:true,claimToken:null};}
      db.run("UPDATE _relay_trash_archives SET phase='dispatched',dispatch_token_hash=?,dispatch_writer_nonce=? WHERE job_id=? AND thread_id=?",[createHash('sha256').update(command.input.claimToken).digest('hex'),writerNonce,jobId,input.threadId]);
      return{jobId,threadId:input.threadId,claimed:true,alreadyConfirmed:false,claimToken:command.input.claimToken};
    }
    const evidence=command.input.evidence,restore=evidence.kind==='provider-reply'?!evidence.wasAlreadyArchived:true;
    if(principal.kind==='system'&&evidence.kind!=='fresh-observation')deny('FORBIDDEN');
    if(effect.phase==='confirmed'){if(Boolean(effect.restore_required)!==restore)deny('CONFLICT');return{jobId,threadId:input.threadId,confirmed:true as const};}
    if(effect.phase!=='dispatched'||job.phase!=='prepared')deny('CONFLICT');
    db.run("UPDATE _relay_trash_archives SET phase='confirmed',restore_required=?,evidence=? WHERE job_id=? AND thread_id=?",[Number(restore),evidence.kind,jobId,input.threadId]);
    return{jobId,threadId:input.threadId,confirmed:true as const};
  }
  if(job.phase==='committed')return readSoftDeleteJob(db,jobId)!;
  if(!actor||principal.kind!=='user')deny('FORBIDDEN');current(db,job,actor);
  if(db.get("SELECT 1 FROM _relay_trash_archives WHERE job_id=? AND phase!='confirmed' LIMIT 1",[jobId]))deny('CONFLICT');
  audit(db,actor,job,'started');
  const rows=db.all('SELECT session_id,thread_id,prior_restore FROM _relay_soft_delete_sessions WHERE job_id=? AND was_deleted=0',[jobId]);
  for(const row of rows){const effect=row.thread_id?db.get('SELECT restore_required FROM _relay_trash_archives WHERE job_id=? AND thread_id=?',[jobId,row.thread_id]):null;
    if(effect){
      db.run('UPDATE sessions SET deleted_at=?,updated_at=?,codex_archived=1,codex_archived_for_trash=? WHERE id=?',[now,now,Number(row.prior_restore===1||effect.restore_required===1),row.session_id]);
    }else db.run('UPDATE sessions SET deleted_at=?,updated_at=? WHERE id=?',[now,now,row.session_id]);}
  db.run("DELETE FROM sidebar_order_items WHERE item_type='session' AND item_id IN(SELECT session_id FROM _relay_soft_delete_sessions WHERE job_id=?)",[jobId]);
  if(job.kind==='project'){
    db.run('UPDATE projects SET deleted_at=?,updated_at=? WHERE id=?',[now,now,job.project_id]);
    db.run("DELETE FROM sidebar_order_items WHERE (item_type='project' AND item_id=?) OR scope=?",[job.project_id,`project:${job.project_id}`]);db.run('DELETE FROM sidebar_order_scopes WHERE scope=?',[`project:${job.project_id}`]);
  }
  const barrier=beginArchiveSnapshot(db).version;
  db.run("UPDATE _relay_storage_observations SET latest_applied=?,snapshot_digest=? WHERE scope='codex-archive'",[barrier,createHash('sha256').update('soft-delete:'+jobId).digest('hex')]);
  db.run("UPDATE _relay_soft_delete_jobs SET phase='committed',updated_at=? WHERE id=?",[now,jobId]);audit(db,actor,job,'succeeded');return readSoftDeleteJob(db,jobId)!;
}
