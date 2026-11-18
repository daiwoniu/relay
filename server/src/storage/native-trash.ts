import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,CoreCommandName,TrashRestorePlan,TrashRestoreResult,TrashReadInputs,TrashReadOutputs } from './contracts.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import * as legacy from '../db/queries-trash.js';
import { createMessageSearchSnippet,createLiteralSearchPattern } from '../db/queries.js';
import { TrashProjectListResponseDtoSchema,TrashSessionListResponseDtoSchema } from '../contracts/index.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
import { readTrashImpact } from './native-trash-impact.js';
import { readTrashPeople } from './native-trash-people.js';
type DB=ReturnType<typeof nativeQueries>;type Actor={id:string;role:string};
const id=z.string().uuid(),q=z.string().trim().max(100),page={limit:z.number().int().min(1).max(100),offset:z.number().int().min(0).max(100000)};
const creatorId=z.string().trim().min(1).max(128).optional();
const reads={projects:z.object({...page,q,creatorId}).strict(),sessions:z.object({...page,q,creatorId,projectId:id.nullable()}).strict(),projectSessions:z.object({...page,projectId:id}).strict(),
  options:z.object({}).strict(),preview:z.object({sessionId:id}).strict(),matches:z.object({sessionId:id,q:q.refine(v=>v.length>0),offset:page.offset}).strict(),restorePlan:z.object({kind:z.enum(['project','session']),id}).strict(),impact:z.object({kind:z.enum(['project','session']),id}).strict()};
export function isTrashCommand(name:string):name is 'trash.restoreProject'|'trash.restoreSession'{return name==='trash.restoreProject'||name==='trash.restoreSession';}
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
function owned(actor:Actor,owner:unknown){if(typeof owner!=='string'||!owner||owner!==actor.id&&actor.role!=='admin')deny('FORBIDDEN');}
function project(db:DB,actor:Actor,projectId:string){const row=db.get('SELECT id,owner_user_id,path,name,deleted_at,is_system FROM projects WHERE id=? AND deleted_at IS NOT NULL',[projectId]);if(!row)deny('NOT_FOUND');owned(actor,row.owner_user_id);return row;}
function previewable(db:DB,actor:Actor,sessionId:string){const row=legacy.getPreviewableTrashSessionOwnerInDatabase(db,sessionId);if(!row||!row.project_owner_user_id)deny('NOT_FOUND');owned(actor,row.owner_user_id);}
function match(db:DB,sessionId:string,query:string,offset=0){
  const pattern=createLiteralSearchPattern(query),where="session_id=? AND role IN ('user','assistant') AND LOWER(content) LIKE LOWER(?) ESCAPE '\\'";
  const total=Number(db.get(`SELECT count(*) AS count FROM messages WHERE ${where}`,[sessionId,pattern])?.count);
  const head=db.get(`SELECT id,length(CAST(content AS BLOB)) AS bytes FROM messages WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET ?`,[sessionId,pattern,offset]);
  if(!head)return {total,items:[]};if(Number(head.bytes)>7*1024*1024)deny('PAYLOAD_TOO_LARGE');
  const row=db.get('SELECT id,role,content,created_at FROM messages WHERE session_id=? AND id=?',[sessionId,head.id]);if(!row)deny('CONFLICT');
  return {total,items:[{id:String(row.id),role:String(row.role),content:createMessageSearchSnippet(String(row.content),query,1200).text,createdAt:Number(row.created_at)}]};
}
function sessionDto(row:legacy.DeletedSessionRow){return {id:row.id,title:row.title,projectId:row.project_id,projectName:row.project_name,engine:row.engine,engineSessionId:row.engine_session_id,deletedAt:Number(row.deleted_at),messageCount:Number(row.message_count),assistantMessageCount:row.assistant_message_count};}
function summary(db:DB,sessionId:string,query:string){if(!query)return {};const found=match(db,sessionId,query),first=found.items[0];return first?{matchMessageId:first.id,matchCount:found.total,matchSnippet:first.content}:{};}
function restoration(db:DB,actor:Actor,kind:'project'|'session',target:string){
  let p:Record<string,any>,rows:Record<string,any>[];
  const columns='id,owner_user_id,deleted_at,status,active_attempt_id,engine,engine_session_id,codex_thread_id,codex_archived_for_trash,message_revision';
  if(kind==='project'){p=project(db,actor,target);rows=db.all(`SELECT ${columns} FROM sessions WHERE project_id=? ORDER BY created_at,id LIMIT 10001`,[target]);}
  else {
    const s=db.get(`SELECT ${columns},project_id FROM sessions WHERE id=? AND deleted_at IS NOT NULL`,[target]);if(!s)deny('NOT_FOUND');owned(actor,s.owner_user_id);
    const parent=db.get('SELECT id,owner_user_id,path,name,deleted_at,is_system FROM projects WHERE id=? AND deleted_at IS NULL',[s.project_id]);if(!parent?.owner_user_id)deny('CONFLICT');p=parent;rows=[s];
  }
  if(rows.length>10000)deny('PAYLOAD_TOO_LARGE');
  if(rows.some(s=>!s.owner_user_id||s.active_attempt_id||!['idle','completed','failed','stopped','interrupted'].includes(String(s.status))))deny('CONFLICT');
  const clause=kind==='project'?'session_id IN (SELECT id FROM sessions WHERE project_id=?)':'session_id=?';
  if(db.get(`SELECT 1 AS found FROM engine_resource_leases WHERE ${clause} LIMIT 1`,[target])
    ||db.get(`SELECT 1 AS found FROM engine_queue_entries WHERE ${clause} AND state IN ('queued','claimed','running') LIMIT 1`,[target])
    ||db.get(`SELECT 1 AS found FROM _relay_external_operations WHERE ${clause} AND phase IN ('prepared','dispatched') LIMIT 1`,[target]))deny('CONFLICT');
  const sourceDigest=createHash('sha256').update(canonicalJson({kind,target,project:p,sessions:rows})).digest('hex');
  const plan:TrashRestorePlan={kind,id:target,ownerUserId:String(kind==='project'?p.owner_user_id:rows[0]!.owner_user_id),projectId:String(p.id),projectPath:String(p.path),sourceDigest,sessionIds:rows.map(s=>String(s.id))};
  return {plan,rows};
}
export function readTrash<K extends keyof TrashReadInputs>(db:DB,actor:Actor,name:K,raw:unknown):TrashReadOutputs[K]{
  if(!Object.hasOwn(reads,name))deny('INVALID_ARGUMENT');const parsed=reads[name].safeParse(raw);if(!parsed.success)deny('INVALID_ARGUMENT');
  const input=parsed.data as any,owner=actor.role==='admin'?undefined:actor.id;let result:unknown;
  if(name==='projects'){
    const filter={query:input.q,creatorId:input.creatorId},rows=legacy.listDeletedProjectsInDatabase(db,input.limit,input.offset,owner,filter);
    const matches=input.q?legacy.listTrashProjectMatchingSessionsInDatabase(db,rows.map(r=>r.id),input.q):[];
    const people=readTrashPeople(db,'project',rows.map(r=>r.id)),matchedPeople=readTrashPeople(db,'session',matches.map(r=>r.id));
    result=TrashProjectListResponseDtoSchema.parse({items:rows.map(row=>{const found=matches.find(m=>m.project_id===row.id),matched=found?matchedPeople.get(found.id):null;return {id:row.id,name:row.name,path:row.path,deletedAt:Number(row.deleted_at),sessionCount:Number(row.session_count),...people.get(row.id),
      ...(found?{matchSessionId:found.id,matchSessionTitle:found.title,matchSessionMessageCount:Number(found.message_count),matchSessionAssistantMessageCount:found.assistant_message_count,matchSessionEngine:found.engine,matchSessionEngineSessionId:found.engine_session_id,matchSessionDeletedAt:Number(found.deleted_at),matchSessionCreator:matched?.creator??null,matchSessionDeletedBy:matched?.deletedBy??null,...summary(db,found.id,input.q)}:{})};}),total:legacy.countDeletedProjectsInDatabase(db,owner,filter),limit:input.limit,offset:input.offset});
  }else if(name==='sessions'){
    const filter={query:input.q,creatorId:input.creatorId,...(input.projectId?{projectId:input.projectId}:{})},rows=legacy.listDeletedSessionsInDatabase(db,input.limit,input.offset,owner,filter);
    const people=readTrashPeople(db,'session',rows.map(r=>r.id));
    result=TrashSessionListResponseDtoSchema.parse({items:rows.map(r=>({...sessionDto(r),...people.get(r.id),...summary(db,r.id,input.q)})),total:legacy.countDeletedSessionsInDatabase(db,owner,filter),limit:input.limit,offset:input.offset});
  }else if(name==='projectSessions'){
    project(db,actor,input.projectId);const rows=legacy.listProjectTrashSessionsInDatabase(db,input.projectId,input.limit,input.offset,owner),people=readTrashPeople(db,'session',rows.map(r=>r.id));
    result=TrashSessionListResponseDtoSchema.parse({items:rows.map(r=>({...sessionDto(r),...people.get(r.id)})),total:legacy.countProjectTrashSessionsInDatabase(db,input.projectId,owner),limit:input.limit,offset:input.offset});
  }else if(name==='options'){
    result=db.all(`SELECT p.id,p.name,p.path FROM projects p WHERE p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM sessions s WHERE s.project_id=p.id AND s.deleted_at IS NOT NULL ${owner?'AND s.owner_user_id=?':''}) ORDER BY LOWER(p.name),p.id LIMIT 501`,owner?[owner]:[]);
    if((result as any[]).length>500)deny('PAYLOAD_TOO_LARGE');
  }else if(name==='preview'){
    previewable(db,actor,input.sessionId);
    const space=' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    const rows=db.all(`SELECT id,role,substr(CAST(trim(coalesce(content,''),?) AS BLOB),1,1120) AS content,created_at FROM
      (SELECT id,role,content,created_at FROM messages WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 500) ORDER BY created_at,id`,[space,input.sessionId]);
    const users=rows.flatMap((r,i)=>r.role==='user'?[i]:[]),start=users.at(-5)??0;
    result=rows.slice(start).map(r=>({id:String(r.id),role:String(r.role),content:(r.content instanceof Uint8Array?Buffer.from(r.content).toString('utf8'):String(r.content)).slice(0,280),createdAt:Number(r.created_at)}));
  }else if(name==='matches'){previewable(db,actor,input.sessionId);result=match(db,input.sessionId,input.q,input.offset);}
  else if(name==='impact')result=readTrashImpact(db,actor,input.kind,input.id);
  else result=restoration(db,actor,input.kind,input.id).plan;
  canonicalJson(result,7*1024*1024);return result as TrashReadOutputs[K];
}
export function authorizeTrashReceipt(db:DB,actor:Actor,value:TrashRestoreResult){
  const row=value.kind==='project'?db.get('SELECT owner_user_id FROM projects WHERE id=?',[value.resourceId]):db.get('SELECT owner_user_id FROM sessions WHERE id=?',[value.resourceId]);
  if(!row)deny('NOT_FOUND');owned(actor,row.owner_user_id);
}
export function executeTrash(db:DB,actor:Actor,command:Extract<CoreCommand,{name:'trash.restoreProject'|'trash.restoreSession'}>):TrashRestoreResult{
  const kind=command.name==='trash.restoreProject'?'project':'session',target=command.name==='trash.restoreProject'?command.input.projectId:command.input.sessionId;
  const {plan,rows}=restoration(db,actor,kind,target);if(plan.sourceDigest!==command.input.sourceDigest)deny('CONFLICT');
  const now=Date.now(),action=kind==='project'?'project.restore':'session.restore';
  const audit=(result:'started'|'succeeded')=>{if(actor.role==='admin')appendAdminAuditEventInDatabase(db,{actorUserId:actor.id,action,resourceType:kind,resourceId:target,ownerUserId:plan.ownerUserId,result,occurredAt:now},randomUUID);};audit('started');
  if(kind==='project'){
    db.run('UPDATE projects SET deleted_at=NULL,pinned=0,pinned_at=NULL,updated_at=? WHERE id=?',[now,target]);
    db.run('UPDATE sessions SET deleted_at=NULL,pinned=0,pinned_at=NULL,updated_at=? WHERE project_id=?',[now,target]);
    db.run("DELETE FROM sidebar_order_items WHERE (item_type='project' AND item_id=?) OR scope=? OR (item_type='session' AND item_id IN (SELECT id FROM sessions WHERE project_id=?))",[target,`project:${target}`,target]);
  }else{db.run('UPDATE sessions SET deleted_at=NULL,pinned=0,pinned_at=NULL,updated_at=? WHERE id=?',[now,target]);db.run("DELETE FROM sidebar_order_items WHERE item_type='session' AND item_id=?",[target]);}
  audit('succeeded');
  return {kind,resourceId:target,ownerUserId:plan.ownerUserId,projectId:plan.projectId,sessionIds:plan.sessionIds,
    unarchive:rows.filter(r=>r.engine==='codex'&&r.codex_archived_for_trash===1&&r.codex_thread_id).map(r=>({sessionId:String(r.id),threadId:String(r.codex_thread_id)}))};
}
