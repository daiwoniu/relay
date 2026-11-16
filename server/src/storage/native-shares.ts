import { createHash,randomUUID,randomBytes } from 'node:crypto';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,CoreCommandName,CoreStoragePort } from './contracts.js';
import { requireManagedResource } from './native-resource-writes.js';
import { visibleResource } from './native-resources.js';
import { presentSharedMessage,readShareSnapshot } from '../shares/snapshot.js';
import { resolveShareExpiry,validateShareSelection,getShareManagementStatus,SHARE_SNAPSHOT_BYTES_MAX,SHARE_SNAPSHOT_MESSAGE_MAX } from '../shares/model.js';
import { CreateShareRequestSchema,SharePreviewResponseDtoSchema,ShareSnapshotV1Schema,ShareListResponseDtoSchema,EngineIdSchema } from '../contracts/index.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
import type { AttachmentAvailability } from '../messages/presenter.js';
type DB=ReturnType<typeof nativeQueries>;
type Actor={id:string;role:string};
const names=['share.create','share.revoke','share.delete'] as const;
export const isShareCommand=(name:string):name is typeof names[number]=>(names as readonly string[]).includes(name);
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export const shareRequestDigest=(request:unknown)=>createHash('sha256').update(canonicalJson(request)).digest('hex');
// Match JS trim for the empty final-answer operation-record rule without loading the body to JS.
const whitespace=' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
function completedCutoff(db:DB,sessionId:string){
  for(const row of db.iterate(`SELECT id,created_at,phase,stopped,length(CAST(trim(content,?) AS BLOB)) AS body_length,
    CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.outcome') ELSE NULL END AS outcome
    FROM messages WHERE session_id=? AND role='assistant' ORDER BY created_at DESC,id DESC`,[whitespace,sessionId])){
    const outcome=['completed','failed','stopped','interrupted'].includes(row.outcome)?row.outcome:null;
    const operation=row.phase==='interaction'||row.phase==='final_answer'&&!row.body_length&&!row.stopped&&(!outcome||outcome==='completed');
    if(!operation&&(outcome??(row.phase==='error'?'failed':row.stopped===1?'stopped':'completed'))==='completed')return row;
  }
  deny('INVALID_ARGUMENT');
}
export function prepareShare(db:DB,actor:Actor,raw:unknown,availability:AttachmentAvailability,now=Date.now()){
  const parsed=CreateShareRequestSchema.safeParse(raw);if(!parsed.success||validateShareSelection(parsed.data))deny('INVALID_ARGUMENT');const request=parsed.data;
  requireManagedResource(db,actor,'session',request.sessionId);
  const source=db.get('SELECT id,owner_user_id,project_id,engine,engine_bound,message_revision FROM sessions WHERE id=?',[request.sessionId])!;
  const cutoff=completedCutoff(db,request.sessionId);
  const selected=request.scope==='session'?null:[...new Set(request.messageIds)];
  const where=`session_id=? AND (created_at<? OR (created_at=? AND id<=?))${selected?` AND id IN (${selected.map(()=>'?').join(',')})`:" AND role IN ('user','assistant')"}`;
  const params=[request.sessionId,cutoff.created_at,cutoff.created_at,cutoff.id,...(selected??[])];
  const count=Number(db.get(`SELECT count(*) AS count FROM messages WHERE ${where}`,params)?.count);
  if(selected&&count!==selected.length)deny('INVALID_ARGUMENT');if(count>SHARE_SNAPSHOT_MESSAGE_MAX)deny('PAYLOAD_TOO_LARGE');
  const headers=db.all(`SELECT id,coalesce(length(CAST(content AS BLOB)),0)+coalesce(length(CAST(metadata AS BLOB)),0)${request.includeProcess?'+coalesce(length(CAST(items AS BLOB)),0)':''} AS bytes
    FROM messages WHERE ${where} ORDER BY created_at,id`,params);
  const hash=createHash('sha256').update(canonicalJson({source,request,cutoffId:cutoff.id}));
  const messages:import('../contracts/index.js').ShareSnapshotMessage[]=[];let bytes=0;
  const states=new Map<string,boolean>();
  for(const header of headers){
    if(Number(header.bytes)>7*1024*1024)deny('PAYLOAD_TOO_LARGE');
    const row=db.get(`SELECT id,session_id,turn_id,role,content,phase,${request.includeProcess?'items':'NULL AS items'},metadata,created_at,duration,stopped FROM messages WHERE id=? AND session_id=?`,[header.id,request.sessionId]);
    if(!row)deny('CONFLICT');hash.update('\n').update(canonicalJson(row));
    const message=presentSharedMessage(row as any,request.includeProcess,(filename)=>{const value=availability(filename);states.set(filename,value);return value;});
    if(!message)continue;bytes+=Buffer.byteLength(JSON.stringify(message))+1;if(bytes>SHARE_SNAPSHOT_BYTES_MAX)deny('PAYLOAD_TOO_LARGE');messages.push(message);
  }
  if(!messages.length)deny('INVALID_ARGUMENT');
  const snapshot=ShareSnapshotV1Schema.parse({version:1,scope:request.scope,includeProcess:request.includeProcess,sourceEngine:source.engine_bound?EngineIdSchema.parse(source.engine):'codex',messages});
  const snapshotJson=JSON.stringify(snapshot);if(Buffer.byteLength(snapshotJson)>SHARE_SNAPSHOT_BYTES_MAX)deny('PAYLOAD_TOO_LARGE');
  let expiresAt:number|null;try{expiresAt=resolveShareExpiry(request.expiry,now);}catch{deny('INVALID_ARGUMENT');}
  return {source,request,sourceDigest:hash.digest('hex'),snapshotJson,availability:[...states] as Array<[string,boolean]>,
    preview:SharePreviewResponseDtoSchema.parse({title:request.title,messageCount:messages.length,createdAt:now,expiresAt,snapshot})};
}
export function authorizeShareReceipt(actor:Actor,value:{ownerUserId:string}){if(actor.id!==value.ownerUserId&&actor.role!=='admin')deny('FORBIDDEN');}
export function executeShare(db:DB,actor:Actor,command:Extract<CoreCommand,{name:typeof names[number]}>){
  const now=Date.now();
  if(command.name==='share.create'){
    const input=command.input,states=new Map(input.availability),prepared=prepareShare(db,actor,input.request,(filename)=>{if(!states.has(filename))deny('CONFLICT');return states.get(filename)!;},now);
    if(prepared.sourceDigest!==input.sourceDigest)deny('CONFLICT');
    const shareId=randomUUID(),publicToken=randomBytes(32).toString('hex');
    const audit=(result:'started'|'succeeded')=>{if(actor.role==='admin')appendAdminAuditEventInDatabase(db,{actorUserId:actor.id,action:'share.create_from_session',resourceType:'session',resourceId:input.request.sessionId,
      ownerUserId:String(prepared.source.owner_user_id),result,occurredAt:now},randomUUID);};audit('started');
    db.run(`INSERT INTO shared_records(id,public_token,owner_user_id,source_session_id,title,scope,message_count,include_process,snapshot_version,snapshot_json,created_at,expires_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,?,1,?,?,?,NULL)`,[shareId,publicToken,actor.id,input.request.sessionId,input.request.title,input.request.scope,prepared.preview.messageCount,Number(input.request.includeProcess),prepared.snapshotJson,now,prepared.preview.expiresAt]);
    audit('succeeded');return {shareId,publicToken,createdAt:now,expiresAt:prepared.preview.expiresAt,ownerUserId:actor.id,requestDigest:shareRequestDigest(input.request)};
  }
  const row=db.get('SELECT id,owner_user_id,expires_at,revoked_at FROM shared_records WHERE id=?',[command.input.shareId]);if(!row)deny('NOT_FOUND');authorizeShareReceipt(actor,{ownerUserId:String(row.owner_user_id)});
  const action=command.name==='share.revoke'?'share.revoke':'share.delete';
  const audit=(result:'started'|'succeeded')=>{if(actor.role==='admin')appendAdminAuditEventInDatabase(db,{actorUserId:actor.id,action,resourceType:'share',resourceId:String(row.id),ownerUserId:String(row.owner_user_id),result,occurredAt:now},randomUUID);};audit('started');
  if(command.name==='share.revoke'){if(row.revoked_at!==null)deny('CONFLICT');db.run('UPDATE shared_records SET revoked_at=? WHERE id=?',[now,row.id]);}
  else {if(getShareManagementStatus({expiresAt:row.expires_at,revokedAt:row.revoked_at},now)==='active')deny('CONFLICT');db.run('DELETE FROM shared_records WHERE id=?',[row.id]);}
  audit('succeeded');return {shareId:String(row.id),ownerUserId:String(row.owner_user_id)};
}
export function listShares(db:DB,actor:Actor,limit:number,offset:number):Awaited<ReturnType<CoreStoragePort['listShares']>>{
  const params=actor.role==='admin'?[]:[actor.id],where=actor.role==='admin'?'':'WHERE r.owner_user_id=?';
  const rows=db.all(`SELECT r.id,r.public_token,r.title,r.scope,r.message_count,r.include_process,r.source_session_id,r.created_at,r.expires_at,r.revoked_at,
    s.id AS source_id,s.deleted_at AS source_deleted_at,s.title AS source_title,s.engine AS source_engine,s.owner_user_id AS source_owner_user_id,json_valid(r.snapshot_json) AS valid_snapshot,
    CASE WHEN json_valid(r.snapshot_json) THEN json_extract(r.snapshot_json,'$.sourceEngine') ELSE NULL END AS saved_engine
    FROM shared_records r LEFT JOIN sessions s ON s.id=r.source_session_id ${where} ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`,[...params,limit,offset]);
  return ShareListResponseDtoSchema.parse({items:rows.map((r)=>{const visible=actor.role==='admin'||r.source_owner_user_id===actor.id||r.source_session_id&&visibleResource(db,actor,{kind:'session',id:r.source_session_id});
    const engine=r.saved_engine??(visible?r.source_engine:null);
    return {id:r.id,publicToken:r.public_token,title:r.title,scope:r.scope,messageCount:r.message_count,includeProcess:r.include_process===1,
    sourceSessionId:r.source_session_id,sourceSessionTitle:visible?r.source_title??null:null,
    sourceState:!r.source_id?'deleted':!visible?'unavailable':r.source_deleted_at!==null?'deleted':'available',
    sourceEngine:EngineIdSchema.safeParse(engine).success?engine:'codex',createdAt:r.created_at,
    expiresAt:r.expires_at,revokedAt:r.revoked_at,status:getShareManagementStatus({expiresAt:r.expires_at,revokedAt:r.revoked_at},Date.now())};}),
    total:Number(db.get(`SELECT count(*) AS count FROM shared_records r ${where}`,params)?.count)});
}
export function publicShare(db:DB,token:string):Awaited<ReturnType<CoreStoragePort['readPublicShare']>>{
  const row=db.get(`SELECT title,message_count,created_at,expires_at,revoked_at,snapshot_version,length(CAST(snapshot_json AS BLOB)) AS bytes FROM shared_records WHERE public_token=?`,[token]);
  if(!row)return {state:'not_found'};
  const state=getShareManagementStatus({expiresAt:row.expires_at,revokedAt:row.revoked_at},Date.now());if(state!=='active')return {state};
  if(Number(row.bytes)>SHARE_SNAPSHOT_BYTES_MAX||row.snapshot_version!==1)return {state:'unreadable'};
  const body=db.get('SELECT snapshot_json FROM shared_records WHERE public_token=?',[token]);if(!body)deny('STORAGE_UNAVAILABLE');
  try{return {state:'active',title:row.title,messageCount:row.message_count,createdAt:row.created_at,expiresAt:row.expires_at,snapshot:readShareSnapshot(row.snapshot_version,String(body.snapshot_json))};}
  catch{return {state:'unreadable'};}
}
