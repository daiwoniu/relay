import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { nativeQueries } from './native-queries.js';
import type { CoreCommandInputs,CoreCommandOutputs,StoragePrincipal } from './contracts.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import { insertMessagesInOpenTransaction } from '../db/queries.js';
import { isClosedAsyncQuestion } from './native-question-close.js';
type DB=ReturnType<typeof nativeQueries>;
const deny=():never=>{throw new StorageContractError('CONFLICT');};
export function createAsyncQuestionSchema(db:DB){db.exec(`CREATE TABLE _relay_async_questions(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,question_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,turn_id TEXT NOT NULL,item_json TEXT NOT NULL,item_digest TEXT NOT NULL,answer_message_id TEXT,created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,question_id));CREATE INDEX _relay_async_answer ON _relay_async_questions(session_id,answer_message_id)`);}
export function recordAsyncQuestion(db:DB,runtime:Extract<StoragePrincipal,{kind:'runtime'}>,input:CoreCommandInputs['turn.recordAsyncQuestion']):CoreCommandOutputs['turn.recordAsyncQuestion']{
  const item=input.item;
  if(!item.id.startsWith('async-question:')||item.id.length>256||item.type!=='interaction'||item.status!=='in_progress'||item.details.interactionKind!=='async_question')deny();
  if(!z.array(z.object({title:z.string().trim().min(1).max(2000),options:z.array(z.string().min(1).max(2000)).max(100).optional()}).strict()).min(1).max(16).safeParse(item.details.questions).success)deny();
  const session=db.get(`SELECT s.active_attempt_id,s.active_turn_id,s.message_revision FROM sessions s JOIN projects p ON p.id=s.project_id
    WHERE s.id=? AND s.engine='codex' AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,[runtime.sessionId]);if(!session)deny();
  const observedRecovery=session!.active_turn_id===null&&!!db.get("SELECT 1 FROM engine_turn_facts WHERE session_id=? AND attempt_id=? AND source='recovery' AND external_turn_id=? LIMIT 1",[runtime.sessionId,runtime.attemptId,input.turnId]);
  const active=session!.active_attempt_id===runtime.attemptId&&(session!.active_turn_id===input.turnId||observedRecovery)&&!!db.get("SELECT 1 FROM engine_resource_leases WHERE session_id=? AND attempt_id=? AND state IN ('claimed','running')",[runtime.sessionId,runtime.attemptId]);
  if(!active&&(session!.active_attempt_id!==null||!db.get(`SELECT 1 FROM engine_terminal_decisions WHERE session_id=? AND attempt_id=? AND external_turn_id=? AND projected_at IS NOT NULL`,[runtime.sessionId,runtime.attemptId,input.turnId])))deny();
  const itemJson=canonicalJson(item,256*1024),digest=createHash('sha256').update(itemJson).digest('hex');
  const previous=db.get('SELECT item_digest,item_json,answer_message_id,attempt_id,turn_id FROM _relay_async_questions WHERE session_id=? AND question_id=?',[runtime.sessionId,item.id]);
  if(previous){if(previous.item_digest!==digest||previous.attempt_id!==runtime.attemptId||previous.turn_id!==input.turnId)deny();const priorItem=JSON.parse(previous.item_json),closed=isClosedAsyncQuestion(priorItem);return{inserted:false,open:previous.answer_message_id===null&&!closed,savedMessage:null,revision:Number(session!.message_revision),...(closed?{closedItem:priorItem}:{})};}
  const now=Date.now();db.run('INSERT INTO _relay_async_questions VALUES(?,?,?,?,?,?,NULL,?)',[runtime.sessionId,item.id,runtime.attemptId,input.turnId,itemJson,digest,now]);
  if(active)return{inserted:true,open:true,savedMessage:null,revision:Number(session!.message_revision)};
  const id='async-question:'+createHash('sha256').update(JSON.stringify([runtime.sessionId,item.id])).digest('hex');
  const saved=insertMessagesInOpenTransaction(db,[{id,session_id:runtime.sessionId,turn_id:item.id,role:'assistant',content:'',phase:'interaction',items:canonicalJson([item]),metadata:null,duration:null,stopped:0}],now)[0]!;
  // insertMessages may compact assistant items; the receipt must reference the bytes actually stored.
  const row=db.get('SELECT * FROM messages WHERE id=?',[id])!;return{inserted:true,open:true,revision:saved.revision,savedMessage:{id:row.id,sessionId:row.session_id,turnId:row.turn_id,role:row.role,content:row.content,phase:row.phase,items:row.items,metadata:row.metadata,createdAt:row.created_at,durationMs:row.duration,stopped:row.stopped===1}};
}
export function asyncQuestionAvailable(db:DB,userId:string,sessionId:string,questionId:string,messageId:string){
  return !!db.get(`SELECT 1 FROM _relay_async_questions q JOIN sessions s ON s.id=q.session_id JOIN projects p ON p.id=s.project_id
    WHERE q.session_id=? AND q.question_id=? AND s.owner_user_id=? AND s.engine='codex' AND s.deleted_at IS NULL AND p.deleted_at IS NULL
    AND coalesce(json_extract(q.item_json,'$.details.resolvedAction'),'')<>'cancel'
    AND (q.answer_message_id IS NULL OR q.answer_message_id=?)`,[sessionId,questionId,userId,messageId]);
}
/** Claim an answer in the same transaction as its user message or held followup. */
export function claimAsyncAnswer(db:DB,userId:string,sessionId:string,messageId:string,questionId:string|null|undefined){
  if(!questionId)return;if(!asyncQuestionAvailable(db,userId,sessionId,questionId,messageId))deny();
  db.run('UPDATE _relay_async_questions SET answer_message_id=? WHERE session_id=? AND question_id=?',[messageId,sessionId,questionId]);
}
export function releaseAsyncAnswer(db:DB,sessionId:string,messageId:string){
  if(!db.get("SELECT 1 FROM messages WHERE session_id=? AND id=? AND role='user'",[sessionId,messageId]))
    db.run('UPDATE _relay_async_questions SET answer_message_id=NULL WHERE session_id=? AND answer_message_id=?',[sessionId,messageId]);
}
