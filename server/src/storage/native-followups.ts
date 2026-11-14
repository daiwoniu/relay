import type { CoreCommand,CoreStoragePort,StoragePrincipal,CoreCommandOutputs } from './contracts.js';
import type { nativeQueries } from './native-queries.js';
import { StorageContractError,canonicalJson } from './command-boundary.js';
import { insertSessionFollowup,transitionSessionFollowup,parseFollowup } from '../db/session-followups.js';
import { insertMessagesInOpenTransaction } from '../db/queries.js';
import { serializeMessageMetadata } from '../message-metadata.js';
import { claimAsyncAnswer,releaseAsyncAnswer } from './native-async-questions.js';
type DB=ReturnType<typeof nativeQueries>;
type Name=Extract<CoreCommand['name'],`followup.${string}`>;
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
function session(db:DB,id:string,finishing=false){
  const row=db.get(`SELECT s.* FROM sessions s JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=s.owner_user_id
    WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND (?=1 OR u.disabled_at IS NULL)`,[id,Number(finishing)]);if(!row)deny('NOT_FOUND');return row!;
}
function record(db:DB,id:string,sessionId:string){const row=db.get('SELECT * FROM session_followups WHERE id=? AND session_id=?',[id,sessionId]);if(!row)deny('NOT_FOUND');return parseFollowup(row!);}
export function readFollowupState(db:DB,principal:StoragePrincipal,id:string,selectedId?:string):Awaited<ReturnType<CoreStoragePort['readFollowupState']>>{
  const row=session(db,id);if(principal.kind==='user'&&row.owner_user_id!==principal.userId)deny('FORBIDDEN');
  if(!row.engine_bound||!row.engine)deny('NOT_SUPPORTED');
  const records=db.all("SELECT * FROM session_followups WHERE session_id=? AND state NOT IN ('steered','delivered','cancelled') ORDER BY created_at,id LIMIT 33",[id]).map(parseFollowup);
  if(records.length>32)deny('OVERLOADED');
  const value={sessionId:id,ownerUserId:String(row.owner_user_id),projectId:String(row.project_id),engineId:row.engine,preferencesRevision:Number(row.engine_preferences_revision),
    modelId:row.selected_model_id??null,reasoningEffort:row.selected_reasoning_effort??null,serviceTier:row.selected_service_tier??null,
    activeAttemptId:row.active_attempt_id??null,turnId:row.active_turn_id??null,status:String(row.status),records,selected:selectedId?record(db,selectedId,id):null};canonicalJson(value,1024*1024);return value;
}
export function isFollowupCommand(name:string):name is Name{return ['followup.submit','followup.transition','followup.prepareSteer','followup.confirmSteer'].includes(name);}
export function executeFollowup(db:DB,principal:StoragePrincipal,command:Extract<CoreCommand,{name:Name}>):CoreCommandOutputs[Name]{
  const input=command.input,row=session(db,input.sessionId,command.name==='followup.confirmSteer');
  if(principal.kind==='user'&&row.owner_user_id!==principal.userId)deny('FORBIDDEN');
  if(command.name==='followup.submit'){
    if(principal.kind!=='user')deny('FORBIDDEN');const input=command.input;
    if(!row.engine_bound||!row.engine)deny('NOT_SUPPORTED');
    if(!input.content.trim()&&!input.attachments.length)deny('INVALID_ARGUMENT');
    claimAsyncAnswer(db,principal.userId,input.sessionId,input.messageId,input.replyToAsyncQuestionId);
    const count=db.get("SELECT count(*) AS n FROM session_followups WHERE session_id=? AND state NOT IN ('steered','delivered','cancelled')",[input.sessionId]);
    if(Number(count?.n)>=32&&!db.get('SELECT 1 FROM session_followups WHERE id=?',[input.messageId]))deny('OVERLOADED');
    const previous=db.get('SELECT MAX(created_at) AS latest FROM session_followups WHERE session_id=?',[input.sessionId]);
    return insertSessionFollowup(db,{id:input.messageId,sessionId:input.sessionId,userId:principal.userId,content:input.content,attachmentsJson:canonicalJson(input.attachments),
      replyToAsyncQuestionId:input.replyToAsyncQuestionId,targetTurnId:row.active_turn_id??null,createdAt:Math.max(Date.now(),Number(previous?.latest??0)+1),...(input.origin?{origin:input.origin}:{})});
  }
  const current=record(db,command.input.id,command.input.sessionId);
  if(command.name==='followup.transition'){
    const input=command.input;
    if(principal.kind==='user'&&!['queued','cancelled'].includes(input.to))deny('FORBIDDEN');
    if(current.state!==input.from)deny('CONFLICT');
    const next=transitionSessionFollowup(db,{id:current.id,from:input.from,to:input.to,updatedAt:Date.now(),errorCode:input.errorCode});
    if(input.to==='cancelled')releaseAsyncAnswer(db,input.sessionId,current.id);return next;
  }
  if(command.name==='followup.prepareSteer'){
    const input=command.input;
    const first=db.get("SELECT id FROM session_followups WHERE session_id=? AND state NOT IN ('steered','delivered','cancelled') ORDER BY created_at,id LIMIT 1",[input.sessionId]);
    const prepared=current.state==='received'&&first?.id===current.id&&current.attachmentsJson==='[]'&&row.active_attempt_id===input.attemptId&&row.active_turn_id===input.turnId&&row.status==='processing';
    if(prepared)db.run('UPDATE session_followups SET target_turn_id=? WHERE id=?',[input.turnId,current.id]);
    return{prepared,record:prepared?transitionSessionFollowup(db,{id:current.id,from:'received',to:'steering',updatedAt:Date.now()}):current};
  }
  if(!['steering','steered'].includes(current.state)&&!(current.state==='uncertain'&&current.errorCode==='STEER_MESSAGE_SAVE_FAILED'))deny('CONFLICT');
  if(!current.targetTurnId)deny('CONFLICT');
  let message=db.get('SELECT * FROM messages WHERE id=?',[current.id]);let revision=Number(row.message_revision);
  if(message&&message.session_id!==current.sessionId)deny('CONFLICT');
  if(!message){
    const saved=insertMessagesInOpenTransaction(db,[{id:current.id,session_id:current.sessionId,turn_id:current.targetTurnId!,role:'user',content:current.content,
      phase:null,items:null,metadata:serializeMessageMetadata({origin:current.origin,replyToAsyncQuestionId:current.replyToAsyncQuestionId??undefined}),stopped:0,duration:null}],Date.now())[0]!;
    message=saved.message;revision=saved.revision;
  }
  const next=current.state==='steered'?current:transitionSessionFollowup(db,{id:current.id,from:current.state,to:'steered',updatedAt:Date.now()});
  return{record:next,revision,savedMessage:{id:message!.id,sessionId:message!.session_id,turnId:message!.turn_id,role:message!.role,content:message!.content,phase:message!.phase,
    items:message!.items,metadata:message!.metadata,createdAt:message!.created_at,durationMs:message!.duration,stopped:message!.stopped===1}};
}
