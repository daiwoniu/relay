import { z } from 'zod';
import type { CoreStoragePort,StoredRecoveryTurn,StoragePrincipal } from './contracts.js';
import type { nativeQueries } from './native-queries.js';
import { claimedPayload } from './native-scheduler.js';
import { StorageContractError } from './command-boundary.js';
import { EngineIdSchema,TokenUsageDtoSchema,ProcessItemDtoSchema } from '../contracts/index.js';
import { canonicalJson } from './command-boundary.js';
import { randomUUID } from 'node:crypto';
import { markLeaseRunningInDatabase,appendCapacityEventInDatabase,getCooldownInDatabase,upsertCooldownInDatabase } from '../db/engine-concurrency.js';
import { acceptCooldownProbe } from '../engine/concurrency/cooldown.js';
type DB=ReturnType<typeof nativeQueries>;
const id=z.string().min(1).max(256),principal=z.object({kind:z.literal('system'),purpose:z.literal('recovery')}).strict();
const deny=():never=>{throw new StorageContractError('CONFLICT');};
export function runtimeRecoveryPage(db:DB,input:Parameters<CoreStoragePort['readRuntimeRecoveryPage']>[0]){
  const value=z.object({principal,after:id.nullable(),limit:z.number().int().min(1).max(32)}).strict().parse(input);
  const rows=db.all(`SELECT id FROM sessions WHERE deleted_at IS NULL AND ((active_attempt_id IS NOT NULL AND status<>'queued') OR status IN ('pending','processing','recovering','stopping'))
    AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`,[value.after,value.after,value.limit+1]);
  const sessionIds=rows.slice(0,value.limit).map(row=>String(row.id));return{sessionIds,next:rows.length>value.limit?sessionIds.at(-1)!:null};
}
export function runtimeRecoveryTurn(db:DB,input:Parameters<CoreStoragePort['readRuntimeRecoveryTurn']>[0]):StoredRecoveryTurn{
  const value=z.object({principal,sessionId:id}).strict().parse(input);
  const row=db.get(`SELECT s.active_attempt_id,s.active_turn_id,s.active_turn_started_at,s.status,s.recovery_previous_status,s.active_turn_usage,s.token_usage,
    q.id AS queue_id,q.user_message_id,q.engine_id,q.resource_key,q.requested_by_user_id,q.claim_token,l.lease_token
    FROM sessions s JOIN projects p ON p.id=s.project_id
    JOIN engine_queue_entries q ON q.session_id=s.id AND q.attempt_id=s.active_attempt_id AND q.state='claimed' AND q.engine_id=s.engine
    JOIN engine_resource_leases l ON l.session_id=s.id AND l.attempt_id=q.attempt_id AND l.engine_id=q.engine_id AND l.resource_key=q.resource_key AND l.state IN ('claimed','running')
    WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND s.status IN ('pending','processing','awaiting_action','stopping','recovering')`,[value.sessionId]);
  if(!row)deny();
  const claim={sessionId:value.sessionId,attemptId:String(row!.active_attempt_id),queueId:String(row!.queue_id),userMessageId:String(row!.user_message_id),engineId:EngineIdSchema.parse(row!.engine_id),
    resourceKey:String(row!.resource_key),requestedByUserId:String(row!.requested_by_user_id),claimToken:String(row!.claim_token),leaseToken:String(row!.lease_token)};
  if(!row!.claim_token||!row!.lease_token)deny();const payload=claimedPayload(db,claim);if(!payload)deny();
  const usage=(raw:unknown)=>{const parsed=TokenUsageDtoSchema.safeParse(JSON.parse(String(raw??'null')));if(!parsed.success&&raw!==null)deny();return parsed.success?parsed.data:null;};
  const questions=db.all('SELECT item_json FROM _relay_async_questions WHERE session_id=? AND attempt_id=? ORDER BY created_at,question_id LIMIT 129',[value.sessionId,claim.attemptId]);if(questions.length>128)deny();
  const asyncQuestions=questions.map(question=>ProcessItemDtoSchema.parse(JSON.parse(question.item_json)));canonicalJson(asyncQuestions,2*1024*1024);
  return{claim,payload:payload!,turnId:row!.active_turn_id,startedAt:row!.active_turn_started_at,previousStatus:row!.status==='recovering'?row!.recovery_previous_status:row!.status,
    tokenUsage:usage(row!.active_turn_usage),latestTokenUsage:usage(row!.token_usage),asyncQuestions};
}
export function prepareRuntimeRecovery(db:DB,runtime:Extract<StoragePrincipal,{kind:'runtime'}>){
  const row=db.get('SELECT status,recovery_previous_status FROM sessions WHERE id=? AND active_attempt_id=?',[runtime.sessionId,runtime.attemptId]);
  if(!row||!['pending','processing','awaiting_action','stopping','recovering'].includes(row.status))deny();
  const previousStatus=row!.status==='recovering'?row!.recovery_previous_status:row!.status;
  if(!['pending','processing','awaiting_action','stopping'].includes(previousStatus))deny();
  db.run("UPDATE sessions SET status='recovering',recovery_previous_status=? WHERE id=?",[previousStatus,runtime.sessionId]);return{previousStatus};
}
export function projectRecoveredRuntime(db:DB,runtime:Extract<StoragePrincipal,{kind:'runtime'}>,input:{externalTurnId:string;pendingCount:number;waitingOnInteraction:boolean}){
  const row=db.get('SELECT status,active_turn_id,active_turn_started_at,recovery_previous_status FROM sessions WHERE id=? AND active_attempt_id=?',[runtime.sessionId,runtime.attemptId]);
  if(!row||!['recovering','stopping','awaiting_action','processing'].includes(row.status)||row.active_turn_id&&row.active_turn_id!==input.externalTurnId)deny();
  if(!db.get(`SELECT 1 FROM engine_turn_facts f WHERE session_id=? AND attempt_id=? AND external_turn_id=? AND fact_type='recovery_in_progress' AND source='recovery'
    AND (connection_id=? OR EXISTS(SELECT 1 FROM _relay_storage_operations o WHERE o.scope_session_id=f.session_id AND o.command_name='turn.appendFact'
      AND json_extract(o.principal_json,'$.connectionId')=? AND json_extract(o.principal_json,'$.runtimeVersion')=? AND json_extract(o.result_json,'$.fact.id')=f.id)) LIMIT 1`,[runtime.sessionId,runtime.attemptId,input.externalTurnId,runtime.connectionId,runtime.connectionId,runtime.runtimeVersion]))deny();
  if(db.get("SELECT 1 FROM engine_turn_facts WHERE session_id=? AND attempt_id=? AND fact_type IN ('final_answer_completed','recovery_completed','engine_error','connection_closed','recovery_failed','recovery_interrupted','interrupt_confirmed') LIMIT 1",[runtime.sessionId,runtime.attemptId]))deny();
  // A request can be replayed and resolved before the recovery snapshot arrives.
  // Its committed processing state is newer than the snapshot's wait hint.
  const waiting=input.pendingCount>0||row!.status!=='processing'&&input.waitingOnInteraction;
  const status=row!.status==='stopping'||row!.recovery_previous_status==='stopping'?'stopping':waiting?'awaiting_action':'processing';
  const startedAt=row!.active_turn_started_at??Date.now();
  db.run('UPDATE sessions SET status=?,active_turn_id=?,active_turn_started_at=? WHERE id=?',[status,input.externalTurnId,startedAt,runtime.sessionId]);
  const lease=db.get('SELECT state,resource_key FROM engine_resource_leases WHERE session_id=? AND attempt_id=?',[runtime.sessionId,runtime.attemptId]);if(!lease)deny();
  markLeaseRunningInDatabase(db,runtime.attemptId,startedAt);
  if(lease!.state!=='running'){
    appendCapacityEventInDatabase(db,{id:randomUUID(),resourceKey:lease!.resource_key,attemptId:runtime.attemptId,eventType:'start_accepted',occurredAt:Date.now()});
    const cooldown=getCooldownInDatabase(db,lease!.resource_key);if(cooldown?.probeAttemptId===runtime.attemptId)upsertCooldownInDatabase(db,acceptCooldownProbe(cooldown,runtime.attemptId,Date.now()));
  }
  return{status,startedAt};
}
