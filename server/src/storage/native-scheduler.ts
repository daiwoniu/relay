import { z } from 'zod';
import { createHash } from 'node:crypto';
import { EngineIdSchema } from '../contracts/dto.js';
import type { CoreStoragePort,StoredClaimedTurn,QueueClaim } from './contracts.js';
import { StorageContractError,canonicalJson } from './command-boundary.js';
import type { nativeQueries } from './native-queries.js';
import { getConcurrencySettingInDatabase, getCooldownInDatabase } from '../db/engine-concurrency.js';
import { assertPurgeWriteFence } from './native-purge.js';
import { assertDeletionWriteFence } from './native-deletion-fence.js';
import { assertUploadCleanupWriteFence } from './native-upload-cleanup.js';
import { canDispatchFeishuRelayTurn } from './native-feishu-im.js';
import { feishuExecutionBinding, isFeishuExecutionActor, isFeishuExecutionResource } from '../integrations/feishu-im/native-session-scope.js';
import { feishuDefaultConcurrency } from '../integrations/feishu-im/inbound.js';

type DB=ReturnType<typeof nativeQueries>;
const id=z.string().min(1).max(256);
const principal=z.object({kind:z.literal('system'),purpose:z.literal('scheduler')}).strict();
const claim=z.object({queueId:id,sessionId:id,attemptId:id,userMessageId:id,engineId:EngineIdSchema,resourceKey:id,requestedByUserId:id,claimToken:id,leaseToken:id}).strict();
function parse<T>(schema:z.ZodType<T>,input:unknown):T{const result=schema.safeParse(input);if(!result.success)throw new StorageContractError('INVALID_ARGUMENT');return result.data;}

export function feishuClaimLimit(db: DB, key: string): number {
  const configured = db.get('SELECT max_concurrent FROM feishu_im_runtime WHERE singleton=1')?.max_concurrent ?? feishuDefaultConcurrency;
  const activeElsewhere = db.get(`SELECT count(*) AS total FROM engine_resource_leases
    WHERE resource_key<>? AND resource_key IN ('codex:feishu','codebuddy:feishu','opencode:feishu','zcode:feishu')`, [key]);
  return Math.max(0, Number(configured) - Number(activeElsewhere?.total ?? 0));
}

export function schedulerState(db:DB,input:Parameters<CoreStoragePort['readSchedulerState']>[0],defaults:Readonly<Record<string,number>>){
  const value=parse(z.object({principal,resourceKey:id}).strict(),input);
  const limit=getConcurrencySettingInDatabase(db,value.resourceKey)?.maxActiveTurns??(Object.hasOwn(defaults,value.resourceKey)?defaults[value.resourceKey]:undefined);
  if(!Number.isSafeInteger(limit)||limit!<1||limit!>32)throw new StorageContractError('NOT_SUPPORTED');
  const current=getCooldownInDatabase(db,value.resourceKey);
  return {cooldownUntil:current?.cooldownUntil??null,probeAttemptId:current?.probeAttemptId??null};
}

export function queueDispatch(db:DB,input:Parameters<CoreStoragePort['checkQueueDispatch']>[0]):boolean{
  const value=parse(z.object({principal,claim,sourceDigest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),input),c=value.claim;
  const row=db.get(`SELECT s.owner_user_id, requester.role AS requester_role FROM engine_queue_entries q
    JOIN engine_resource_leases l ON l.attempt_id=q.attempt_id AND l.session_id=q.session_id
    JOIN sessions s ON s.id=q.session_id JOIN projects p ON p.id=s.project_id
    JOIN users owner ON owner.id=s.owner_user_id JOIN users requester ON requester.id=q.requested_by_user_id
    WHERE q.id=? AND q.session_id=? AND q.attempt_id=? AND q.user_message_id=? AND q.engine_id=? AND q.resource_key=?
      AND q.requested_by_user_id=? AND q.claim_token=? AND q.state='claimed'
      AND l.lease_token=? AND l.state='claimed' AND l.engine_id=q.engine_id AND l.resource_key=q.resource_key
      AND s.active_attempt_id=q.attempt_id AND s.engine=q.engine_id AND s.status='pending' AND s.deleted_at IS NULL AND p.deleted_at IS NULL
      AND owner.disabled_at IS NULL AND requester.disabled_at IS NULL AND requester.must_change_password=0`,
    [c.queueId,c.sessionId,c.attemptId,c.userMessageId,c.engineId,c.resourceKey,c.requestedByUserId,c.claimToken,c.leaseToken]);
  if(!row||row.owner_user_id!==c.requestedByUserId&&row.requester_role!=='admin')return false;
  if ((isFeishuExecutionActor(c.requestedByUserId) || isFeishuExecutionResource(c.resourceKey)) && !canDispatchFeishuRelayTurn(db,c)) return false;
  const command={name:'queue.markRunning' as const,input:{sessionId:c.sessionId,attemptId:c.attemptId,leaseToken:c.leaseToken}};
  try{assertPurgeWriteFence(db,command,value.principal);assertDeletionWriteFence(db,command,value.principal,'soft');assertUploadCleanupWriteFence(db,command,value.principal);}
  catch(error){if(error instanceof StorageContractError&&error.code==='CONFLICT')return false;throw error;}
  return value.sourceDigest===undefined||claimedPayload(db,c)?.sourceDigest===value.sourceDigest;
}

export function claimedPayload(db:DB,c:QueueClaim):StoredClaimedTurn|null{
  const row=db.get(`SELECT m.id,m.session_id,m.turn_id,m.content,m.metadata,
    s.owner_user_id,s.project_id,p.path,s.engine_session_id,s.engine_metadata,s.context_compaction_count,
    s.engine_preferences_revision,s.selected_model_id,s.selected_reasoning_effort,s.selected_service_tier,q.claimed_at
    FROM messages m JOIN sessions s ON s.id=m.session_id JOIN projects p ON p.id=s.project_id
    JOIN engine_queue_entries q ON q.session_id=s.id AND q.attempt_id=m.turn_id
    WHERE m.id=? AND m.session_id=? AND m.turn_id=? AND m.role='user'
      AND length(CAST(m.content AS BLOB))<=4194304 AND length(CAST(COALESCE(m.metadata,'') AS BLOB))<=524288
      AND length(CAST(COALESCE(s.engine_metadata,'') AS BLOB))<=524288 AND length(p.path)<=32768`,
    [c.userMessageId,c.sessionId,c.attemptId]);
  if(!row)return null;
  const hasFeishu = db.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='feishu_im_matter_sessions'");
  const binding = feishuExecutionBinding(c.requestedByUserId);
  const feishu = binding ? db.get(`SELECT json_extract(data_json,'$.relayTurn.handoff') AS handoff, json_extract(data_json,'$.chatType') AS chatType,
    json_extract(data_json,'$.relayTurn.senderDisplayName') AS senderDisplayName FROM feishu_im_inbox
    WHERE bot_id=? AND json_extract(data_json,'$.relayTurn.messageId')=? AND json_extract(data_json,'$.relayTurn.sessionId')=?`,
  [binding,c.userMessageId,c.sessionId]) : null;
  const handoff = binding ? feishu?.handoff
    : hasFeishu ? db.get(`SELECT h.handoff FROM feishu_im_matter_sessions h WHERE h.session_id=? AND h.handoff IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM messages prior WHERE prior.session_id=h.session_id AND prior.role='assistant'
      AND prior.phase='final_answer' AND COALESCE(prior.stopped,0)=0 AND length(trim(prior.content))>0)`, [c.sessionId])?.handoff : null;
  const data:Omit<StoredClaimedTurn,'sourceDigest'>={claimedAt:row.claimed_at,message:{id:row.id,sessionId:row.session_id,attemptId:row.turn_id,content:row.content,metadata:row.metadata},
    ...(typeof handoff === 'string' ? { feishuHandoff: handoff } : {}),
    ...(typeof feishu?.senderDisplayName === 'string' ? feishu.chatType === 'p2p'
      ? { feishuPrivatePeerDisplayName: feishu.senderDisplayName } : { feishuSenderDisplayName: feishu.senderDisplayName } : {}),
    session:{ownerUserId:row.owner_user_id,projectId:row.project_id,projectPath:row.path,engineSessionId:row.engine_session_id,engineMetadata:row.engine_metadata,
      contextCompactionCount:row.context_compaction_count,preferencesRevision:row.engine_preferences_revision,modelId:row.selected_model_id,
      reasoningEffort:row.selected_reasoning_effort,serviceTier:row.selected_service_tier}};
  canonicalJson(data,6*1024*1024);
  return{...data,sourceDigest:createHash('sha256').update(canonicalJson({claim:c,data},7*1024*1024)).digest('hex')};
}

export function readClaimedTurn(db:DB,input:Parameters<CoreStoragePort['readClaimedTurn']>[0]):StoredClaimedTurn|null{
  const value=parse(z.object({principal,claim}).strict(),input);
  return queueDispatch(db,value)?claimedPayload(db,value.claim):null;
}
