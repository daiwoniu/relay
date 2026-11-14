import { createHash } from 'node:crypto';
import type { CoreCommandInputs,CoreStoragePort,StopRequest,StoragePrincipal } from './contracts.js';
import type { nativeQueries } from './native-queries.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import type { AccessActor } from './native-access.js';
import { assertPurgeWriteFence } from './native-purge.js';
import { assertDeletionWriteFence } from './native-deletion-fence.js';
import { assertUploadCleanupWriteFence } from './native-upload-cleanup.js';
type DB=ReturnType<typeof nativeQueries>;
const auditId=(operationId:string,phase:'started'|'finished')=>'stop:'+createHash('sha256').update(operationId).digest('hex')+':'+phase;
function audit(db:DB,operationId:string,actor:string,request:StopRequest,result:'started'|'succeeded'|'failed'){
  if(!request.adminAudit)return;
  db.run(`INSERT INTO admin_audit_events(id,actor_user_id,action,resource_type,resource_id,owner_user_id,result,occurred_at)
    VALUES(?,?,'session.stop','session',?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    [auditId(operationId,result==='started'?'started':'finished'),actor,request.sessionId,request.ownerUserId,result,Date.now()]);
}
export function requestStop(db:DB,actor:AccessActor,operationId:string,input:CoreCommandInputs['turn.requestStop']):StopRequest{
  const row=db.get(`SELECT s.owner_user_id,s.status,l.lease_token,l.engine_id,l.resource_key FROM sessions s
    JOIN projects p ON p.id=s.project_id JOIN engine_resource_leases l ON l.session_id=s.id AND l.attempt_id=s.active_attempt_id
    WHERE s.id=? AND s.active_attempt_id=? AND s.engine=l.engine_id AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND l.state IN ('claimed','running')`,
    [input.sessionId,input.expectedAttemptId]);
  if(!row)throw new StorageContractError('CONFLICT');
  if(row.owner_user_id!==actor.id&&actor.role!=='admin')throw new StorageContractError('FORBIDDEN');
  if(!['pending','processing','awaiting_action','recovering','stopping'].includes(row.status))throw new StorageContractError('CONFLICT');
  const prior=db.get(`SELECT 1 FROM _relay_storage_operations WHERE command_name='turn.requestStop' AND scope_session_id=?
    AND json_extract(result_json,'$.attemptId')=? AND json_extract(result_json,'$.requested')=1 LIMIT 1`,[input.sessionId,input.expectedAttemptId]);
  const result:StopRequest={requested:row.status!=='stopping'&&!prior,sessionId:input.sessionId,attemptId:input.expectedAttemptId,
    leaseToken:row.lease_token,engineId:row.engine_id,resourceKey:row.resource_key,ownerUserId:row.owner_user_id,
    adminAudit:actor.role==='admin'&&actor.id!==row.owner_user_id};
  if(result.requested){
    audit(db,operationId,actor.id,result,'started');
  }
  db.run("UPDATE sessions SET status='stopping',updated_at=? WHERE id=? AND active_attempt_id=?",[Date.now(),input.sessionId,input.expectedAttemptId]);
  return result;
}
/** The supervisor also verifies its exact registered runtime and current lease before this projection. */
export function checkStop(db:DB,actor:AccessActor,input:Parameters<CoreStoragePort['checkStopDispatch']>[0],leaseToken:string):boolean{
  const row=db.get("SELECT principal_json,result_json FROM _relay_storage_operations WHERE operation_id=? AND command_name='turn.requestStop' AND expired=0",[input.operationId]);
  if(!row)return false;
  const author=JSON.parse(row.principal_json) as StoragePrincipal,result=JSON.parse(row.result_json) as StopRequest;
  if(author.kind!=='user'||author.userId!==actor.id||!result.requested||result.sessionId!==input.runtime.sessionId||result.attemptId!==input.runtime.attemptId||result.leaseToken!==leaseToken)return false;
  const current=db.get(`SELECT s.owner_user_id,l.engine_id,l.resource_key FROM sessions s JOIN projects p ON p.id=s.project_id
    JOIN engine_resource_leases l ON l.session_id=s.id AND l.attempt_id=s.active_attempt_id
    WHERE s.id=? AND s.active_attempt_id=? AND s.status='stopping' AND s.deleted_at IS NULL AND p.deleted_at IS NULL
      AND l.lease_token=? AND l.state IN ('claimed','running')`,[result.sessionId,result.attemptId,result.leaseToken]);
  if(!current||current.owner_user_id!==result.ownerUserId||current.engine_id!==result.engineId||current.resource_key!==result.resourceKey
    ||current.owner_user_id!==actor.id&&actor.role!=='admin')return false;
  const command={name:'turn.requestStop' as const,input:{sessionId:result.sessionId,expectedAttemptId:result.attemptId}};
  try{assertPurgeWriteFence(db,command,input.principal);assertDeletionWriteFence(db,command,input.principal,'soft');assertUploadCleanupWriteFence(db,command,input.principal);}
  catch(error){if(error instanceof StorageContractError&&error.code==='CONFLICT')return false;throw error;}
  return true;
}
/** Runs inside the terminal transaction. A persisted intent alone never produces a successful stop audit. */
export function finishStopAudits(db:DB,sessionId:string,attemptId:string,outcome:string){
  const rows=db.all(`SELECT operation_id,principal_json,result_json FROM _relay_storage_operations
    WHERE command_name='turn.requestStop' AND scope_session_id=? AND json_extract(result_json,'$.attemptId')=?
      AND json_extract(result_json,'$.requested')=1 LIMIT 2`,[sessionId,attemptId]);
  if(rows.length>1)throw new StorageContractError('CONFLICT');
  for(const row of rows){const result=JSON.parse(row.result_json) as StopRequest,actor=JSON.parse(row.principal_json) as StoragePrincipal;
    canonicalJson(result);if(actor.kind!=='user')throw new StorageContractError('STORAGE_UNAVAILABLE');
    audit(db,row.operation_id,actor.userId,result,outcome==='stopped'?'succeeded':'failed');}
}
