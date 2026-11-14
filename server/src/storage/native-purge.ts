import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { nativeQueries } from './native-queries.js';
import type { CoreCommand, PurgeJob, StoragePrincipal } from './contracts.js';
import { canonicalJson, StorageContractError } from './command-boundary.js';
import { readTrashImpact } from './native-trash-impact.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
import { assertDeletionWriteFence } from './native-deletion-fence.js';

type DB=ReturnType<typeof nativeQueries>;type Actor={id:string;role:string}|null;
const names=['trash.preparePurge','trash.startPurgeFiles','trash.bindPurgeProof','trash.commitPurge','trash.rejectPurge','trash.finishPurgeFiles'] as const;
type Name=typeof names[number];
export function isPurgeCommand(name:string):name is Name{return (names as readonly string[]).includes(name);}
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export function authorizePurge(actor:Actor,principal:StoragePrincipal){
  if(principal.kind==='system'&&principal.purpose==='maintenance')return;
  if(principal.kind!=='user'||actor?.role!=='admin')deny('FORBIDDEN');
}
export function createPurgeSchema(db:DB){db.exec(`CREATE TABLE _relay_purge_jobs(
  id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('project','session')),resource_id TEXT NOT NULL,project_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,source_digest TEXT NOT NULL,request_json TEXT NOT NULL,confirmation_name TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('reserved','isolating','prepared','committed','rejected')),
  files_started INTEGER NOT NULL DEFAULT 0,intent_digest TEXT,files_finished INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE INDEX _relay_purge_project ON _relay_purge_jobs(project_id,files_finished);
  CREATE INDEX _relay_purge_pending ON _relay_purge_jobs(id) WHERE files_finished=0;
  CREATE TABLE _relay_purge_sessions(job_id TEXT NOT NULL REFERENCES _relay_purge_jobs(id),session_id TEXT NOT NULL,PRIMARY KEY(job_id,session_id));
  CREATE INDEX _relay_purge_session ON _relay_purge_sessions(session_id,job_id);`);}
export function readPurgeJob(db:DB,id:string):PurgeJob|null{
  const row=db.get('SELECT * FROM _relay_purge_jobs WHERE id=?',[id]);if(!row)return null;
  const request=JSON.parse(String(row.request_json));canonicalJson(request,256*1024);
  return {jobId:String(row.id),kind:row.kind,resourceId:String(row.resource_id),projectId:String(row.project_id),ownerUserId:String(row.owner_user_id),
    confirmationName:row.confirmation_name,phase:row.phase,filesStarted:row.files_started===1,intentDigest:row.intent_digest,filesFinished:row.files_finished===1,request};
}
/** Current scope fence. Receipt replay is handled before this check; it never re-runs the old mutation. */
export function assertPurgeWriteFence(db:DB,command:CoreCommand,principal:StoragePrincipal){
  assertDeletionWriteFence(db,command,principal,'purge');
}
export function executePurge(db:DB,actor:Actor,principal:StoragePrincipal,command:Extract<CoreCommand,{name:Name}>):PurgeJob{
  authorizePurge(actor,principal);const input=command.input,now=Date.now();
  if(command.name==='trash.preparePurge'){
    const input=command.input;
    if(!actor||principal.kind!=='user')deny('FORBIDDEN');
    if(db.get('SELECT 1 FROM _relay_purge_jobs WHERE id=?',[input.jobId]))deny('CONFLICT');
    readTrashImpact(db,actor,input.kind,input.resourceId,input.impactRevision);
    const target=input.kind==='project'?db.get('SELECT id,name,path,owner_user_id FROM projects WHERE id=?',[input.resourceId]):db.get(`SELECT p.id,p.name,p.path,s.owner_user_id FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=?`,[input.resourceId]);
    if(!target)deny('NOT_FOUND');if(input.kind==='project'&&input.confirmationName!==target.name||input.kind==='session'&&input.confirmationName!==null)deny('INVALID_ARGUMENT');
    // One job per project is conservative for concurrent deletion, without blocking unrelated live session facts.
    if(db.get('SELECT 1 FROM _relay_purge_jobs WHERE project_id=? AND files_finished=0 LIMIT 1',[target.id]))deny('CONFLICT');
    const select=input.kind==='project'?'SELECT id FROM sessions WHERE project_id=?':'SELECT id FROM sessions WHERE id=?';
    const entries=db.all(`SELECT m.id AS messageId,s.owner_user_id AS ownerUserId FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE m.session_id IN (${select}) AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.attachments') a
        WHERE json_extract(a.value,'$.kind')='uploaded_file') ORDER BY m.id LIMIT 1025`,[input.resourceId]);
    if(entries.length>1024)deny('PAYLOAD_TOO_LARGE');
    const entrySchema=z.object({messageId:z.string().uuid().refine(v=>v===v.toLowerCase()),ownerUserId:z.string().uuid()}).strict();
    const parsed=z.array(entrySchema).safeParse(entries);if(!parsed.success)deny('CONFLICT');
    const request={operationId:input.jobId,projectPath:String(target.path),projectId:String(target.id),sourceDigest:input.impactRevision,entries:parsed.data};
    db.run(`INSERT INTO _relay_purge_jobs VALUES(?,?,?,?,?,?,?,?,?,'reserved',0,NULL,0,?,?)`,[input.jobId,input.kind,input.resourceId,target.id,target.owner_user_id,actor.id,input.impactRevision,canonicalJson(request,256*1024),input.confirmationName,now,now]);
    db.run(`INSERT INTO _relay_purge_sessions SELECT ?,id FROM sessions WHERE id IN (${select})`,[input.jobId,input.resourceId]);
    return readPurgeJob(db,input.jobId)!;
  }
  const job=readPurgeJob(db,input.jobId);if(!job)deny('NOT_FOUND');
  if(command.name==='trash.startPurgeFiles'){
    if(principal.kind!=='user'||!actor)deny('FORBIDDEN');if(job.phase!=='reserved'||job.filesFinished)deny('CONFLICT');
    readTrashImpact(db,actor,job.kind,job.resourceId,job.request.sourceDigest);
    if(job.request.entries.length===0){
      const emptyProof=createHash('sha256').update(canonicalJson({kind:'no-files-v1',request:job.request})).digest('hex');
      db.run("UPDATE _relay_purge_jobs SET phase='prepared',intent_digest=?,updated_at=? WHERE id=?",[emptyProof,now,job.jobId]);
    }else db.run("UPDATE _relay_purge_jobs SET phase='isolating',files_started=1,updated_at=? WHERE id=?",[now,job.jobId]);
  }else if(command.name==='trash.bindPurgeProof'){
    const input=command.input;
    if(job.filesFinished||!job.filesStarted||!['isolating','prepared','rejected'].includes(job.phase)||job.intentDigest&&job.intentDigest!==input.intentDigest)deny('CONFLICT');
    if(job.phase!=='rejected'){
      if(principal.kind!=='user'||!actor)deny('FORBIDDEN');readTrashImpact(db,actor,job.kind,job.resourceId,job.request.sourceDigest);
    }
    db.run("UPDATE _relay_purge_jobs SET phase=CASE WHEN phase='rejected' THEN phase ELSE 'prepared' END,intent_digest=?,updated_at=? WHERE id=?",[input.intentDigest,now,job.jobId]);
  }else if(command.name==='trash.rejectPurge'){
    if(job.phase==='committed'||job.filesFinished)deny('CONFLICT');
    db.run("UPDATE _relay_purge_jobs SET phase='rejected',updated_at=? WHERE id=?",[now,job.jobId]);
  }else if(command.name==='trash.finishPurgeFiles'){
    const input=command.input;
    if(!['committed','rejected'].includes(job.phase)||input.intentDigest!==job.intentDigest||job.filesStarted&&!job.intentDigest)deny('CONFLICT');
    db.run('UPDATE _relay_purge_jobs SET files_finished=1,updated_at=? WHERE id=?',[now,job.jobId]);
  }else if(command.name==='trash.commitPurge'){
    const input=command.input;
    if(!actor||principal.kind!=='user')deny('FORBIDDEN');
    if(job.phase!=='prepared'||job.filesFinished||job.intentDigest!==input.intentDigest)deny('CONFLICT');
    readTrashImpact(db,actor,job.kind,job.resourceId,job.request.sourceDigest);
    const audit=(result:'started'|'succeeded')=>appendAdminAuditEventInDatabase(db,{actorUserId:actor.id,action:job.kind==='project'?'project.permanent_delete':'session.permanent_delete',resourceType:job.kind,resourceId:job.resourceId,ownerUserId:job.ownerUserId,result,occurredAt:now},randomUUID);
    audit('started');deleteRelations(db,job);db.run("UPDATE _relay_purge_jobs SET phase='committed',updated_at=? WHERE id=?",[now,job.jobId]);audit('succeeded');
  }
  return readPurgeJob(db,job.jobId)!;
}
function deleteRelations(db:DB,job:PurgeJob){
  const select='SELECT session_id FROM _relay_purge_sessions WHERE job_id=?',where=`session_id IN (${select})`;
  const attempts=`SELECT attempt_id FROM engine_terminal_decisions WHERE ${where} UNION SELECT attempt_id FROM engine_turn_facts WHERE ${where} UNION SELECT attempt_id FROM engine_queue_entries WHERE ${where}`;
  for(const table of ['engine_terminal_decisions','engine_turn_facts','engine_queue_entries','engine_resource_leases']){
    if(db.get(`SELECT 1 FROM ${table} WHERE session_id NOT IN (${select}) AND attempt_id IN (${attempts}) LIMIT 1`,[job.jobId,job.jobId,job.jobId,job.jobId]))deny('CONFLICT');
  }
  db.run(`DELETE FROM engine_capacity_events WHERE attempt_id IN (${attempts})`,[job.jobId,job.jobId,job.jobId]);
  // Shared provider cooldown state belongs to the provider, only detach the deleted attempt.
  db.run(`UPDATE engine_provider_cooldowns SET probe_attempt_id=NULL WHERE probe_attempt_id IN (${attempts})`,[job.jobId,job.jobId,job.jobId]);
  const external=`SELECT id FROM _relay_external_operations WHERE ${where}`;
  db.run(`DELETE FROM _relay_fork_messages WHERE operation_id IN (${external})`,[job.jobId]);
  db.run(`DELETE FROM _relay_forks WHERE id IN (${external})`,[job.jobId]);
  for(const table of ['workspace_console_links','shared_records','context_compaction_events','engine_terminal_decisions','engine_turn_facts','engine_queue_entries',
    'engine_resource_leases','session_read_receipts','session_followups','approval_trust_settings','_relay_external_operations','messages']){
    const column=table==='shared_records'?'source_session_id':'session_id';db.run(`DELETE FROM ${table} WHERE ${column} IN (${select})`,[job.jobId]);
  }
  db.run(`DELETE FROM sidebar_order_items WHERE item_type='session' AND item_id IN (${select})`,[job.jobId]);
  db.run(`DELETE FROM sessions WHERE id IN (${select})`,[job.jobId]);
  if(job.kind==='project'){
    db.run("DELETE FROM sidebar_order_items WHERE (item_type='project' AND item_id=?) OR scope=?",[job.projectId,`project:${job.projectId}`]);
    db.run('DELETE FROM sidebar_order_scopes WHERE scope=?',[`project:${job.projectId}`]);
    db.run('DELETE FROM approval_trust_settings WHERE project_id=?',[job.projectId]);db.run('DELETE FROM project_members WHERE project_id=?',[job.projectId]);
    db.run('DELETE FROM projects WHERE id=?',[job.projectId]);
  }
}
