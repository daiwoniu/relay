import type { nativeQueries } from './native-queries.js';
import { visibleResource } from './native-resources.js';
import { canonicalJson, StorageContractError } from './command-boundary.js';
import type { CoreStoragePort, StoredSessionSync } from './contracts.js';
import { getQueueEntryBySessionInDatabase, countActiveLeasesForUserInDatabase, getConcurrencySettingInDatabase, getCooldownInDatabase } from '../db/engine-concurrency.js';
import { EngineIdSchema, SessionFollowupDtoSchema, TokenUsageDtoSchema } from '../contracts/index.js';
import { pendingAsyncQuestions } from './native-pending-questions.js';
import { presentFollowupAttachments } from '../messages/followup-attachments.js';
type DB = ReturnType<typeof nativeQueries>;
type Actor = { id:string;role:'admin'|'member' };
function deny(code: ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export function frontendSync(db:DB,actor:Actor,input:Parameters<CoreStoragePort['readFrontendSync']>[0]) {
  if(input.scope==='all'&&actor.role!=='admin')deny('FORBIDDEN');
  const rows=db.all(`SELECT r.session_id,r.message_id FROM session_read_receipts r JOIN sessions s ON s.id=r.session_id
    JOIN projects p ON p.id=s.project_id LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
    WHERE r.user_id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL AND s.owner_user_id IS NOT NULL
    AND (?=1 OR s.owner_user_id=? OR p.owner_user_id=? OR (pm.role IN ('viewer','collaborator','manager') AND pm.can_view_sessions=1)) LIMIT 10001`,
  [actor.id,actor.id,Number(actor.role==='admin'),actor.id,actor.id]);
  if(rows.length>10000)deny('PAYLOAD_TOO_LARGE');
  const sessions=input.runtimeSessionIds.flatMap((id)=>{
    if(!visibleResource(db,actor,{kind:'session',id}))return [];
    const row=db.get('SELECT id,title,engine,engine_bound,owner_user_id,active_attempt_id,message_revision FROM sessions WHERE id=?',[id])!;
    // Approval authority is ownership/admin, distinct from viewing a shared session.
    if(row.owner_user_id!==actor.id&&actor.role!=='admin'||actor.role==='admin'&&input.scope==='mine'&&row.owner_user_id!==actor.id&&id!==input.activeSessionId)return [];
    if(!row.engine_bound)return [];
    return [{id:String(row.id),title:String(row.title),engine:EngineIdSchema.parse(row.engine),activeAttemptId:row.active_attempt_id??null,
      ownerUserId:String(row.owner_user_id),messageRevision:Number(row.message_revision??0)}];
  });
  const result={role:actor.role,receipts:Object.fromEntries(rows.map((r)=>[String(r.session_id),String(r.message_id)])),sessions,asyncQuestions:pendingAsyncQuestions(db,actor.id)};
  canonicalJson(result,1024*1024);return result;
}
export function sessionSyncExtras(db:DB,actor:Actor,id:string):Pick<StoredSessionSync,'activeAttemptId'|'queue'|'followups'|'usage'> {
  const row=db.get(`SELECT owner_user_id,active_attempt_id,length(CAST(token_usage AS BLOB)) AS usage_bytes,
    CASE WHEN length(CAST(token_usage AS BLOB))<=65536 THEN token_usage ELSE NULL END AS token_usage FROM sessions WHERE id=?`,[id]);if(!row)deny('NOT_FOUND');
  if(Number(row.usage_bytes)>65536)deny('PAYLOAD_TOO_LARGE');
  const entry=getQueueEntryBySessionInDatabase(db,id);
  let queue:StoredSessionSync['queue']=null;
  if(entry){
    const ahead=db.get(`SELECT count(*) AS count FROM engine_queue_entries WHERE resource_key=? AND requested_by_user_id=? AND state='queued'
      AND (created_at<? OR (created_at=? AND id<=?))`,[entry.resourceKey,entry.requestedByUserId,entry.createdAt,entry.createdAt,entry.id]);
    queue={queueId:entry.id,sessionId:id,engineId:entry.engineId,resourceKey:entry.resourceKey,state:entry.state,
      position:entry.state==='queued'?Number(ahead?.count):null,activeTurns:countActiveLeasesForUserInDatabase(db,entry.resourceKey,entry.requestedByUserId),
      maxActiveTurns:getConcurrencySettingInDatabase(db,entry.resourceKey)?.maxActiveTurns??null,cooldownUntil:getCooldownInDatabase(db,entry.resourceKey)?.cooldownUntil??null,createdAt:entry.createdAt};
  }
  let followups:StoredSessionSync['followups']=null;
  if(row.owner_user_id===actor.id){
    const size=db.get(`SELECT count(*) AS count,coalesce(sum(length(CAST(content AS BLOB))+length(CAST(id AS BLOB))
      +length(CAST(attachments_json AS BLOB))+coalesce(length(CAST(error_code AS BLOB)),0)+coalesce(length(CAST(reply_to_async_question_id AS BLOB)),0)),0) AS bytes FROM session_followups WHERE session_id=?`,[id]);
    if(Number(size?.count)>500||Number(size?.bytes)>1024*1024)deny('PAYLOAD_TOO_LARGE');
    followups=db.all(`SELECT id,session_id AS sessionId,content,state,created_at AS createdAt,error_code AS errorCode,reply_to_async_question_id AS replyToAsyncQuestionId,attachments_json
      FROM session_followups WHERE session_id=? ORDER BY created_at,id`,[id]).map(({attachments_json,...r})=>SessionFollowupDtoSchema.parse({...r,attachments:presentFollowupAttachments(String(attachments_json))}));
  }
  let usage:StoredSessionSync['usage']=null;
  if(row.token_usage){try{usage=TokenUsageDtoSchema.parse(JSON.parse(String(row.token_usage)));}catch{deny('STORAGE_UNAVAILABLE');}}
  return {activeAttemptId:row.active_attempt_id??null,queue,followups,usage};
}
