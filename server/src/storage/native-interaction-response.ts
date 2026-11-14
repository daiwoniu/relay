import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EngineIdSchema } from '../contracts/dto.js';
import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,CoreCommandInputs,InteractionResponseJob,StoragePrincipal } from './contracts.js';
import type { AccessActor } from './native-access.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import { assertPurgeWriteFence } from './native-purge.js';
import { assertDeletionWriteFence } from './native-deletion-fence.js';
import { assertUploadCleanupWriteFence } from './native-upload-cleanup.js';
import { standaloneSource } from './native-standalone-interactions.js';
type DB=ReturnType<typeof nativeQueries>;
const id=z.string().min(1).max(256),digest=z.string().regex(/^[a-f0-9]{64}$/);
const jobSchema=z.object({jobId:id,actorUserId:id,ownerUserId:id,adminAudit:z.boolean(),sessionId:id,attemptId:id,connectionId:id,
  runtimeVersion:z.number().int().positive().safe(),engineId:EngineIdSchema,leaseToken:id,interactionId:id,requestDigest:digest,responseDigest:digest,claimToken:id,
  phase:z.enum(['prepared','submitted','rejected']),standalone:z.literal(true).optional()}).strict();
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export function createInteractionResponseSchema(db:DB){db.exec(`CREATE TABLE _relay_interaction_responses(
  job_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,attempt_id TEXT NOT NULL,connection_id TEXT NOT NULL,runtime_version INTEGER NOT NULL,
  interaction_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('prepared','submitted','rejected')),job_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX _relay_interaction_current ON _relay_interaction_responses(session_id,attempt_id,connection_id,runtime_version,interaction_id) WHERE phase<>'rejected';
  CREATE INDEX _relay_interaction_pending ON _relay_interaction_responses(phase,updated_at)`);}
export function readInteractionJob(db:DB,jobId:string):InteractionResponseJob|null{
  const row=db.get(`SELECT job_id,session_id,attempt_id,connection_id,runtime_version,interaction_id,phase,
    CASE WHEN length(CAST(job_json AS BLOB))<=32768 THEN job_json ELSE NULL END AS job_json
    FROM _relay_interaction_responses WHERE job_id=?`,[jobId]);if(!row)return null;
  let job:InteractionResponseJob;try{job=jobSchema.parse({...JSON.parse(row.job_json),phase:row.phase});}catch{return deny('STORAGE_UNAVAILABLE');}
  if(job.jobId!==row.job_id||job.sessionId!==row.session_id||job.attemptId!==row.attempt_id||job.connectionId!==row.connection_id
    ||job.runtimeVersion!==row.runtime_version||job.interactionId!==row.interaction_id)deny('STORAGE_UNAVAILABLE');
  return job;
}
export function authorizeInteractionJob(db:DB,actor:AccessActor,job:InteractionResponseJob){
  if(job.actorUserId!==actor.id)deny('FORBIDDEN');
  const source=db.get(`SELECT s.owner_user_id FROM sessions s JOIN projects p ON p.id=s.project_id
    WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,[job.sessionId]);
  if(!source||source.owner_user_id!==job.ownerUserId||source.owner_user_id!==actor.id&&actor.role!=='admin')deny('FORBIDDEN');
}
function audit(db:DB,job:InteractionResponseJob,result:'started'|'succeeded'|'failed'){
  if(!job.adminAudit)return;
  const id='interaction:'+createHash('sha256').update(job.jobId).digest('hex')+':'+(result==='started'?'started':'finished');
  db.run(`INSERT INTO admin_audit_events(id,actor_user_id,action,resource_type,resource_id,owner_user_id,result,occurred_at)
    VALUES(?,?,'session.approval_decide','session',?,?,?,?) ON CONFLICT(id) DO NOTHING`,[id,job.actorUserId,job.sessionId,job.ownerUserId,result,Date.now()]);
}
export function source(db:DB,job:Pick<InteractionResponseJob,'sessionId'|'attemptId'|'engineId'|'leaseToken'>&Partial<InteractionResponseJob>){
  if(job.standalone)return standaloneSource(db,job as InteractionResponseJob);
  return db.get(`SELECT s.owner_user_id FROM sessions s JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=s.owner_user_id
    JOIN engine_resource_leases l ON l.session_id=s.id AND l.attempt_id=s.active_attempt_id
    WHERE s.id=? AND s.active_attempt_id=? AND s.engine=? AND l.engine_id=s.engine AND l.lease_token=?
      AND l.state IN ('claimed','running') AND s.status IN ('pending','processing','awaiting_action')
      AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND u.disabled_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM _relay_storage_operations o WHERE o.command_name='turn.requestStop'
        AND o.scope_session_id=s.id AND json_extract(o.result_json,'$.attemptId')=s.active_attempt_id AND json_extract(o.result_json,'$.requested')=1)`,
    [job.sessionId,job.attemptId,job.engineId,job.leaseToken]);
}
export function prepareInteractionResponse(db:DB,actor:AccessActor,jobId:string,input:CoreCommandInputs['interaction.prepareResponse'],leaseToken:string):InteractionResponseJob{
  // A recovered request is not permission to retransmit a response whose transport outcome is unknown.
  if(db.get("SELECT 1 FROM _relay_interaction_responses WHERE session_id=? AND phase='prepared' LIMIT 1",[input.sessionId]))deny('CONFLICT');
  const session=db.get('SELECT engine FROM sessions WHERE id=?',[input.sessionId]);if(!session)deny('CONFLICT');
  const current=source(db,{...input,engineId:session.engine,leaseToken});if(!current)deny('CONFLICT');
  if(current.owner_user_id!==actor.id&&actor.role!=='admin')deny('FORBIDDEN');
  if(db.get("SELECT 1 FROM _relay_interaction_responses WHERE session_id=? AND attempt_id=? AND connection_id=? AND runtime_version=? AND interaction_id=? AND phase<>'rejected'",
    [input.sessionId,input.attemptId,input.connectionId,input.runtimeVersion,input.interactionId]))deny('CONFLICT');
  const job:InteractionResponseJob={...input,jobId,actorUserId:actor.id,ownerUserId:current.owner_user_id,
    adminAudit:actor.role==='admin'&&actor.id!==current.owner_user_id,engineId:session.engine,leaseToken,phase:'prepared'};
  const now=Date.now();db.run('INSERT INTO _relay_interaction_responses VALUES(?,?,?,?,?,?,?,?,?,?)',[jobId,job.sessionId,job.attemptId,job.connectionId,job.runtimeVersion,job.interactionId,job.phase,canonicalJson(job),now,now]);audit(db,job,'started');return job;
}
export function checkInteraction(db:DB,actor:AccessActor,job:InteractionResponseJob,claimToken:string,principal:Extract<StoragePrincipal,{kind:'user'}>):boolean{
  authorizeInteractionJob(db,actor,job);
  if(job.phase!=='prepared'||job.claimToken!==claimToken)return false;
  const current=source(db,job);if(!current||current.owner_user_id!==job.ownerUserId)return false;
  const command={name:'interaction.prepareResponse' as const,input:{sessionId:job.sessionId,attemptId:job.attemptId,connectionId:job.connectionId,runtimeVersion:job.runtimeVersion,
    interactionId:job.interactionId,requestDigest:job.requestDigest,responseDigest:job.responseDigest,claimToken:job.claimToken}};
  try{assertPurgeWriteFence(db,command,principal);assertDeletionWriteFence(db,command,principal,'soft');assertUploadCleanupWriteFence(db,command,principal);}
  catch(error){if(error instanceof StorageContractError&&error.code==='CONFLICT')return false;throw error;}
  return true;
}
/** Internal confirmation only; no permission to send any protocol response is granted here. */
export function confirmInteractionResponse(db:DB,input:CoreCommandInputs['interaction.confirmResponse']):InteractionResponseJob{
  const job=readInteractionJob(db,input.jobId);if(!job)deny('NOT_FOUND');
  if(job.claimToken!==input.claimToken||job.requestDigest!==input.requestDigest||job.responseDigest!==input.responseDigest)deny('CONFLICT');
  if(job.phase==='submitted')return job;
  if(job.phase==='rejected')deny('CONFLICT');
  db.run("UPDATE _relay_interaction_responses SET phase='submitted',updated_at=? WHERE job_id=? AND phase='prepared'",[Date.now(),job.jobId]);
  audit(db,job,'succeeded');return{...job,phase:'submitted'};
}

/** Only the original live dispatcher can prove it never invoked the protocol method.
 * Not for unknown submission, process restart, timeout, or manual guesses. */
export function rejectUnsubmittedInteraction(db:DB,input:CoreCommandInputs['interaction.rejectUnsubmitted']):InteractionResponseJob{
  const job=readInteractionJob(db,input.jobId);if(!job)deny('NOT_FOUND');
  if(job.claimToken!==input.claimToken||job.requestDigest!==input.requestDigest||job.responseDigest!==input.responseDigest||job.phase==='submitted')deny('CONFLICT');
  if(job.phase==='rejected')return job;
  db.run("UPDATE _relay_interaction_responses SET phase='rejected',updated_at=? WHERE job_id=? AND phase='prepared'",[Date.now(),job.jobId]);
  audit(db,job,'failed');return{...job,phase:'rejected'};
}

export function pendingInteractionResponse(db:DB,projectId:string):boolean{
  return !!db.get(`SELECT 1 FROM _relay_interaction_responses j JOIN sessions s ON s.id=j.session_id
    WHERE s.project_id=? AND j.phase='prepared' LIMIT 1`,[projectId])||!!db.get(`SELECT 1 FROM session_followups f JOIN sessions s ON s.id=f.session_id
      WHERE s.project_id=? AND f.state='steering' LIMIT 1`,[projectId])||!!db.get(`SELECT 1 FROM _relay_standalone_interactions i JOIN sessions s ON s.id=i.session_id
      WHERE s.project_id=? AND i.phase='pending' LIMIT 1`,[projectId]);
}
/** Facts, terminal settlement, revocation and explicit stop remain available while a reply is unknown. */
export function assertInteractionResponseWriteFence(db:DB,command:CoreCommand){
  if(!db.get("SELECT 1 FROM _relay_interaction_responses WHERE phase='prepared' LIMIT 1")&&!db.get("SELECT 1 FROM session_followups WHERE state='steering' LIMIT 1")&&!db.get("SELECT 1 FROM _relay_standalone_interactions WHERE phase='pending' LIMIT 1"))return;
  const input=command.input as any,project=(id:unknown)=>{if(typeof id==='string'&&pendingInteractionResponse(db,id))deny('CONFLICT');},
    session=(id:unknown)=>{if(typeof id==='string')project(db.get('SELECT project_id FROM sessions WHERE id=?',[id])?.project_id);};
  if(command.name==='turn.enqueue'){session(input.sessionId);project(input.draft?.projectId);}
  if(command.name==='queue.claim'&&db.all(`SELECT DISTINCT s.project_id FROM engine_queue_entries q JOIN sessions s ON s.id=q.session_id
    WHERE q.resource_key=? AND q.state='queued'`,[input.resourceKey]).some(row=>pendingInteractionResponse(db,String(row.project_id))))deny('CONFLICT');
  if(command.name==='project.update')project(input.projectId);
  if(command.name==='session.update'||command.name==='session.prepareFork'||command.name==='session.prepareUnarchive'){
    session(input.sessionId);project(input.changes?.projectId);
  }
  if(command.name==='uploadCleanup.prepare')project(input.projectId);
  if(command.name==='trash.preparePurge'||command.name==='trash.prepareSoftDelete')input.kind==='project'?project(input.resourceId):session(input.resourceId);
  if(command.name==='trash.restoreProject')project(input.projectId);
  if(command.name==='trash.restoreSession')session(input.sessionId);
  if(command.name==='repair.apply')deny('CONFLICT');
}
