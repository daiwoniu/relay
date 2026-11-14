import { createHash } from 'node:crypto';
import type { CoreCommand,StoragePrincipal,UploadCleanupJob } from './contracts.js';
import type { nativeQueries } from './native-queries.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import { readUploadScope } from './native-upload-scope.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
type DB=ReturnType<typeof nativeQueries>;type Actor={id:string;role:string}|null;
const names=['uploadCleanup.prepare','uploadCleanup.startFiles','uploadCleanup.bindProof','uploadCleanup.commit','uploadCleanup.reject','uploadCleanup.finishFiles'] as const;
type Name=typeof names[number];
export const isUploadCleanupCommand=(name:string):name is Name=>(names as readonly string[]).includes(name);
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export function createUploadCleanupSchema(db:DB){db.exec(`CREATE TABLE _relay_upload_cleanup_jobs(
  id TEXT PRIMARY KEY,project_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,request_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('reserved','isolating','prepared','committed','rejected')),
  files_started INTEGER NOT NULL DEFAULT 0,files_finished INTEGER NOT NULL DEFAULT 0,intent_digest TEXT,deleted_count INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX _relay_upload_cleanup_pending ON _relay_upload_cleanup_jobs(project_id) WHERE files_finished=0;`);}
export function readUploadCleanupJob(db:DB,id:string):UploadCleanupJob|null{
  const row=db.get('SELECT * FROM _relay_upload_cleanup_jobs WHERE id=?',[id]);if(!row)return null;const request=JSON.parse(String(row.request_json));canonicalJson(request,16384);
  let sourceCurrent=false,active=true;try{const scope=readUploadScope(db,{id:String(row.owner_user_id),role:'member'},String(row.project_id),id);sourceCurrent=scope.projectPath===request.projectPath&&scope.ownerUserId===row.owner_user_id;active=scope.active;}catch(error){if(!(error instanceof StorageContractError)||!['CONFLICT','NOT_FOUND'].includes(error.code))throw error;}
  return{jobId:String(row.id),projectId:String(row.project_id),ownerUserId:String(row.owner_user_id),actorUserId:String(row.actor_user_id),phase:row.phase,filesStarted:row.files_started===1,filesFinished:row.files_finished===1,intentDigest:row.intent_digest,deletedCount:row.deleted_count,sourceCurrent,active,request};
}
export function authorizeUploadCleanupJob(db:DB,actor:Actor,principal:StoragePrincipal,id:string){
  const job=readUploadCleanupJob(db,id);if(!job)deny('NOT_FOUND');if(principal.kind==='system'&&principal.purpose==='maintenance')return job;
  if(principal.kind!=='user'||!actor||actor.role!=='admin'&&(actor.id!==job.actorUserId||job.request.uploaderUserId===null))deny('FORBIDDEN');
  const scope=readUploadScope(db,actor,job.projectId,job.filesFinished?null:job.jobId);
  if(scope.projectPath!==job.request.projectPath||scope.ownerUserId!==job.ownerUserId)deny('CONFLICT');return job;
}
function audit(db:DB,actor:Actor,job:UploadCleanupJob,result:'started'|'succeeded'|'failed'){
  if(!actor||actor.role!=='admin'||actor.id===job.ownerUserId)return;const id='upload-cleanup:'+createHash('sha256').update(canonicalJson([job.jobId,actor.id,result])).digest('hex');
  if(db.get('SELECT 1 FROM admin_audit_events WHERE id=?',[id]))return;
  appendAdminAuditEventInDatabase(db,{actorUserId:actor.id,action:'project.upload_delete',resourceType:'project',resourceId:job.projectId,ownerUserId:job.ownerUserId,result,occurredAt:Date.now()},()=>id);
}
export function executeUploadCleanup(db:DB,actor:Actor,principal:StoragePrincipal,command:Extract<CoreCommand,{name:Name}>):UploadCleanupJob{
  const now=Date.now();if(command.name==='uploadCleanup.prepare'){
    if(!actor||principal.kind!=='user')deny('FORBIDDEN');const input=command.input,scope=readUploadScope(db,actor,input.projectId);if(scope.active)deny('CONFLICT');
    if(db.get('SELECT 1 FROM _relay_upload_cleanup_jobs WHERE id=?',[input.jobId]))deny('CONFLICT');
    const request:UploadCleanupJob['request']={jobId:input.jobId,projectId:input.projectId,projectPath:scope.projectPath,ownerUserId:scope.ownerUserId,uploaderUserId:actor.role==='admin'?null:actor.id,attachmentIds:input.attachmentIds};
    db.run("INSERT INTO _relay_upload_cleanup_jobs VALUES(?,?,?,?,?,'reserved',0,0,NULL,NULL,?,?)",[input.jobId,input.projectId,scope.ownerUserId,actor.id,canonicalJson(request,16384),now,now]);const job=readUploadCleanupJob(db,input.jobId)!;audit(db,actor,job,'started');return job;
  }
  const job=authorizeUploadCleanupJob(db,actor,principal,command.input.jobId);
  if(principal.kind==='system'&&principal.purpose!=='maintenance')deny('FORBIDDEN');
  const update=(sql:string,args:(string|number|null)[]=[])=>{db.run(sql,[...args,now,job.jobId]);return readUploadCleanupJob(db,job.jobId)!;};
  if(command.name==='uploadCleanup.startFiles'){
    if(principal.kind!=='user'||!actor||job.phase!=='reserved'||job.filesFinished)deny('CONFLICT');const scope=readUploadScope(db,actor,job.projectId,job.jobId);if(scope.active)deny('CONFLICT');audit(db,actor,job,'started');
    return update("UPDATE _relay_upload_cleanup_jobs SET phase='isolating',files_started=1,updated_at=? WHERE id=?");
  }
  if(command.name==='uploadCleanup.reject'){
    if(job.phase==='committed'||job.filesFinished)deny('CONFLICT');audit(db,actor,job,'failed');return update("UPDATE _relay_upload_cleanup_jobs SET phase='rejected',updated_at=? WHERE id=?");
  }
  if(command.name==='uploadCleanup.bindProof'){
    const input=command.input;if(job.filesFinished||!job.filesStarted||!['isolating','prepared','rejected'].includes(job.phase)||job.intentDigest&&job.intentDigest!==input.intentDigest||job.deletedCount!==null&&job.deletedCount!==input.deletedCount)deny('CONFLICT');
    if(principal.kind==='system'&&job.phase!=='rejected')deny('FORBIDDEN');
    if(job.request.attachmentIds&&input.deletedCount>job.request.attachmentIds.length)deny('CONFLICT');
    return update("UPDATE _relay_upload_cleanup_jobs SET phase=CASE WHEN phase='rejected' THEN phase ELSE 'prepared' END,intent_digest=?,deleted_count=?,updated_at=? WHERE id=?",[input.intentDigest,input.deletedCount]);
  }
  if(command.name==='uploadCleanup.commit'){
    if(principal.kind!=='user'||!actor||job.filesFinished||!job.intentDigest||job.intentDigest!==command.input.intentDigest||!['prepared','committed'].includes(job.phase))deny('CONFLICT');
    if(job.phase==='committed')return job;const scope=readUploadScope(db,actor,job.projectId,job.jobId);if(scope.active)deny('CONFLICT');audit(db,actor,job,'started');audit(db,actor,job,'succeeded');
    return update("UPDATE _relay_upload_cleanup_jobs SET phase='committed',updated_at=? WHERE id=?");
  }
  const input=command.input;if(input.intentDigest!==job.intentDigest||!['committed','rejected'].includes(job.phase))deny('CONFLICT');
  if(job.phase==='committed'&&(input.disposition!=='removed'||!job.intentDigest)||job.phase==='rejected'&&(job.filesStarted?input.disposition!=='restored'||!job.intentDigest:input.disposition!=='unmoved'))deny('CONFLICT');
  return update('UPDATE _relay_upload_cleanup_jobs SET files_finished=1,updated_at=? WHERE id=?');
}

/** Retained through byte cleanup/rollback, so a new turn cannot claim files still in quarantine. */
export function assertUploadCleanupWriteFence(db:DB,command:CoreCommand,principal:StoragePrincipal){
  if(isUploadCleanupCommand(command.name)||command.name==='session.markRead'||!db.get('SELECT 1 FROM _relay_upload_cleanup_jobs WHERE files_finished=0 LIMIT 1'))return;
  const input=command.input as any,project=(id:unknown)=>{if(typeof id==='string'&&db.get('SELECT 1 FROM _relay_upload_cleanup_jobs WHERE project_id=? AND files_finished=0',[id]))deny('CONFLICT');};
  const session=(id:unknown)=>{if(typeof id==='string')project(db.get('SELECT project_id FROM sessions WHERE id=?',[id])?.project_id);};
  session(input.sessionId??input.fact?.sessionId??input.decision?.sessionId);
  project(input.projectId??input.changes?.projectId??input.draft?.projectId);
  if(command.name==='session.create'&&input.projectId===null&&principal.kind==='user')project(db.get('SELECT default_project_id FROM users WHERE id=?',[principal.userId])?.default_project_id);
  if(command.name==='trash.preparePurge'||command.name==='trash.prepareSoftDelete')input.kind==='project'?project(input.resourceId):session(input.resourceId);
  if(command.name==='approvalTrust.set'||command.name==='approvalTrust.clear')input.scope==='project'?project(input.scopeId):session(input.scopeId);
  if(command.name==='share.create')session(input.request.sessionId);
  if(command.name==='share.revoke'||command.name==='share.delete')session(db.get('SELECT source_session_id FROM shared_records WHERE id=?',[input.shareId])?.source_session_id);
  if(command.name==='repair.apply')deny('CONFLICT');
  if(command.name==='queue.claim'&&db.get(`SELECT 1 FROM engine_queue_entries q JOIN sessions s ON s.id=q.session_id JOIN _relay_upload_cleanup_jobs j ON j.project_id=s.project_id WHERE q.resource_key=? AND q.state='queued' AND j.files_finished=0 LIMIT 1`,[input.resourceKey]))deny('CONFLICT');
}
