import { createHash } from 'node:crypto';
import type { CoreCommandInputs } from './contracts.js';
import type { nativeQueries } from './native-queries.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import { appendEngineTurnFactInDatabase } from '../db/engine-turn-facts.js';
import { projectEngineTerminalInDatabase } from '../db/queries.js';
import { finishStopAudits } from './native-stop.js';
import { assertPurgeWriteFence } from './native-purge.js';
import { assertDeletionWriteFence } from './native-deletion-fence.js';
import { assertUploadCleanupWriteFence } from './native-upload-cleanup.js';
import { getCooldownInDatabase,upsertCooldownInDatabase } from '../db/engine-concurrency.js';
import { serializeTerminalMessageMetadata } from '../message-metadata.js';
import { sanitizeLocalErrorMessage } from '../engine/diagnostics.js';
type DB=ReturnType<typeof nativeQueries>;

/** Supervisor attests the actual start effect was never invoked. Not a timeout/restart recovery primitive. */
export function finishUnstarted(db:DB,input:CoreCommandInputs['queue.finishUnstarted']){
  const c=input.claim;
  const row=db.get(`SELECT s.status FROM engine_queue_entries q JOIN engine_resource_leases l ON l.attempt_id=q.attempt_id
    JOIN sessions s ON s.id=q.session_id JOIN projects p ON p.id=s.project_id
    WHERE q.id=? AND q.session_id=? AND q.attempt_id=? AND q.user_message_id=? AND q.engine_id=? AND q.resource_key=?
      AND q.requested_by_user_id=? AND q.claim_token=? AND q.state='claimed' AND l.session_id=q.session_id
      AND l.engine_id=q.engine_id AND l.resource_key=q.resource_key AND l.lease_token=? AND l.state='claimed'
      AND s.active_attempt_id=q.attempt_id AND s.engine=q.engine_id AND s.status IN ('pending','stopping')
      AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [c.queueId,c.sessionId,c.attemptId,c.userMessageId,c.engineId,c.resourceKey,c.requestedByUserId,c.claimToken,c.leaseToken]);
  if(!row)throw new StorageContractError('CONFLICT');
  const stop=db.get(`SELECT 1 FROM _relay_storage_operations WHERE command_name='turn.requestStop' AND scope_session_id=?
    AND json_extract(result_json,'$.attemptId')=? AND json_extract(result_json,'$.requested')=1 LIMIT 1`,[c.sessionId,c.attemptId]);
  // An old stopping projection without a durable current intent cannot justify a fabricated local stop.
  if(row.status==='stopping'&&!stop)throw new StorageContractError('CONFLICT');
  const principal={kind:'system',purpose:'scheduler'} as const,scope={name:'queue.markRunning' as const,input:{sessionId:c.sessionId,attemptId:c.attemptId,leaseToken:c.leaseToken}};
  assertPurgeWriteFence(db,scope,principal);assertDeletionWriteFence(db,scope,principal,'soft');assertUploadCleanupWriteFence(db,scope,principal);
  const identity=createHash('sha256').update(canonicalJson(c)).digest('hex'),now=Date.now();
  const code=input.diagnostic?.code??'TURN_START_PREPARATION_FAILED';
  const message=sanitizeLocalErrorMessage(input.diagnostic?.message??'任务准备失败，尚未发送到引擎。');
  const fact=appendEngineTurnFactInDatabase(db,{id:'unstarted-fact:'+identity,sessionId:c.sessionId,attemptId:c.attemptId,engineId:c.engineId,
    connectionId:'unstarted:'+identity,source:'local',sequence:0,observedAt:now,idempotencyKey:'unstarted:'+identity,
    factType:stop?'interrupt_confirmed':'engine_error',payload:stop?{userInitiated:true}:{errorCode:code,retryable:false}}).fact;
  const result=projectEngineTerminalInDatabase(db,{decision:{id:'unstarted-decision:'+identity,sessionId:c.sessionId,attemptId:c.attemptId,
    engineId:c.engineId,outcome:stop?'stopped':'failed',reasonCode:stop?'USER_STOPPED':code,factId:fact.id,decidedAt:now,projectedAt:null},
    sessionStatus:stop?'stopped':'failed',message:{id:input.messageId,session_id:c.sessionId,turn_id:c.attemptId,role:'assistant',
      content:stop?'':message,phase:stop?null:'error',items:null,duration:null,stopped:stop?1:0,
      metadata:serializeTerminalMessageMetadata(stop?'stopped':'failed',stop?{}:{errorCode:code})}});
  if(result.releasedResourceKey){const cooldown=getCooldownInDatabase(db,result.releasedResourceKey);
    if(cooldown?.probeAttemptId===c.attemptId)upsertCooldownInDatabase(db,{...cooldown,probeAttemptId:null,updatedAt:now});}
  finishStopAudits(db,c.sessionId,c.attemptId,result.decision.outcome);
  return result;
}
