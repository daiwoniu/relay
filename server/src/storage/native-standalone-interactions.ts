import { createHash } from 'node:crypto';
import type { nativeQueries } from './native-queries.js';
import type { InteractionResponseJob,StoragePrincipal } from './contracts.js';
import type { ProcessItemDto } from '../contracts/index.js';
import { StorageContractError,canonicalJson } from './command-boundary.js';
import { insertMessagesInOpenTransaction } from '../db/queries.js';
type DB=ReturnType<typeof nativeQueries>;
const deny=():never=>{throw new StorageContractError('CONFLICT');};
export function createStandaloneSchema(db:DB){db.exec(`CREATE TABLE _relay_standalone_interactions(
  interaction_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,attempt_id TEXT NOT NULL,connection_id TEXT NOT NULL,runtime_version INTEGER NOT NULL,
  request_digest TEXT NOT NULL,owner_user_id TEXT NOT NULL,engine_id TEXT NOT NULL,previous_status TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('pending','resolved')),item_json TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE INDEX _relay_standalone_pending ON _relay_standalone_interactions(session_id,phase)`);}
export function beginStandalone(db:DB,runtime:Extract<StoragePrincipal,{kind:'runtime'}>,input:{sessionId:string;interactionId:string;requestDigest:string;item:ProcessItemDto}){
  const row=db.get(`SELECT s.owner_user_id,s.engine,s.status FROM sessions s JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=s.owner_user_id
    WHERE s.id=? AND s.active_attempt_id IS NULL AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND u.disabled_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM engine_resource_leases WHERE session_id=s.id)
    AND EXISTS(SELECT 1 FROM engine_terminal_decisions d WHERE d.session_id=s.id AND d.attempt_id=? AND d.projected_at IS NOT NULL)`,[runtime.sessionId,runtime.attemptId]);
  if(!row||input.item.id!==input.interactionId||input.item.type!=='interaction')deny();
  const previous=db.get("SELECT previous_status FROM _relay_standalone_interactions WHERE session_id=? AND phase='pending' LIMIT 1",[runtime.sessionId]);
  const status=previous?.previous_status??row!.status;if(!['idle','completed','failed','stopped','interrupted'].includes(status))deny();
  if(db.get('SELECT 1 FROM _relay_standalone_interactions WHERE interaction_id=?',[input.interactionId]))deny();
  if(Number(db.get("SELECT count(*) AS n FROM _relay_standalone_interactions WHERE session_id=? AND phase='pending'",[runtime.sessionId])?.n)>=128)throw new StorageContractError('OVERLOADED');
  db.run('INSERT INTO _relay_standalone_interactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[input.interactionId,runtime.sessionId,runtime.attemptId,runtime.connectionId,runtime.runtimeVersion,
    input.requestDigest,row!.owner_user_id,row!.engine,status,'pending',canonicalJson(input.item,256*1024),Date.now()]);
  db.run("UPDATE sessions SET status='awaiting_action' WHERE id=?",[runtime.sessionId]);return{created:true};
}
export function standaloneSource(db:DB,job:Pick<InteractionResponseJob,'sessionId'|'attemptId'|'connectionId'|'runtimeVersion'|'interactionId'|'requestDigest'>){
  return db.get(`SELECT s.owner_user_id,s.engine FROM _relay_standalone_interactions i JOIN sessions s ON s.id=i.session_id JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=s.owner_user_id
    WHERE i.session_id=? AND i.attempt_id=? AND i.connection_id=? AND i.runtime_version=? AND i.interaction_id=? AND i.request_digest=? AND i.phase='pending'
    AND s.active_attempt_id IS NULL AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND u.disabled_at IS NULL
    AND s.owner_user_id=i.owner_user_id AND s.engine=i.engine_id AND NOT EXISTS(SELECT 1 FROM engine_resource_leases WHERE session_id=s.id)`,
    [job.sessionId,job.attemptId,job.connectionId,job.runtimeVersion,job.interactionId,job.requestDigest]);
}
export function resolveStandalone(db:DB,input:{interactionId:string;item:ProcessItemDto},incomplete=false){
  // A provider resolution callback cannot decide whether our concurrent response was submitted.
  if(db.get("SELECT 1 FROM _relay_interaction_responses WHERE interaction_id=? AND phase='prepared'",[input.interactionId]))deny();
  const row=db.get("SELECT * FROM _relay_standalone_interactions WHERE interaction_id=? AND phase='pending'",[input.interactionId]);if(!row)deny();
  const item=input.item;if(item.id!==row!.interaction_id||item.type!=='interaction'||item.status!==(incomplete?'incomplete':'completed'))deny();
  const messageId='standalone:'+createHash('sha256').update(input.interactionId).digest('hex');
  const saved=insertMessagesInOpenTransaction(db,[{id:messageId,session_id:row!.session_id,turn_id:input.interactionId,role:'assistant',content:'',phase:'interaction',items:canonicalJson([item],512*1024),
    metadata:null,stopped:0,duration:null}],Date.now())[0]!;
  db.run("UPDATE _relay_standalone_interactions SET phase='resolved',item_json=? WHERE interaction_id=?",[canonicalJson(item,256*1024),input.interactionId]);
  if(!db.get("SELECT 1 FROM _relay_standalone_interactions WHERE session_id=? AND phase='pending' LIMIT 1",[row!.session_id]))
    db.run('UPDATE sessions SET status=? WHERE id=? AND active_attempt_id IS NULL',[row!.previous_status,row!.session_id]);
  return{sessionId:String(row!.session_id),messageId,revision:saved.revision,item};
}
export function closeStandalone(db:DB,interactionId:string){
  const row=db.get("SELECT item_json FROM _relay_standalone_interactions WHERE interaction_id=? AND phase='pending'",[interactionId]);if(!row)deny();
  if(db.get("SELECT 1 FROM _relay_interaction_responses WHERE interaction_id=? AND phase<>'rejected'",[interactionId]))deny();
  const original=JSON.parse(row!.item_json) as ProcessItemDto;
  return resolveStandalone(db,{interactionId,item:{...original,status:'incomplete',details:{...original.details,
    errorCode:'INTERACTION_CONNECTION_CLOSED',message:'引擎连接已关闭，此操作请求未答复'}}},true);
}
