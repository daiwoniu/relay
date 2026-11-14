import { createHash } from 'node:crypto';
import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,StoredWorkspaceState } from './contracts.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import { FIXED_WORKSPACE_PATH } from '../workspace-console/workspace-snapshot.js';
import { projectSessionCard } from '../workspace-console/session-projection.js';
import { buildWorkspaceDashboard,WORKSPACE_DASHBOARD_MAX_BYTES } from '../workspace-console/dashboard-projection.js';
import { insertWorkspaceLinkInOpenTransaction,type WorkspaceLink } from '../db/queries-workspace-console.js';
import { WorkspaceConsoleDashboardDtoSchema } from '../contracts/index.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
import { feishuWorkItemIdFromTaskId,feishuWorkItemIdFromLaunch } from '../workspace-console/task-reference.js';
type DB=ReturnType<typeof nativeQueries>;type Actor={id:string;role:string};
const names=['workspace.linkSession','workspace.unlinkSession','workspace.beginSnapshot','workspace.saveSnapshot'] as const;
type Name=typeof names[number];
export const isWorkspaceCommand=(name:string):name is Name=>(names as readonly string[]).includes(name);
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export function authorizeWorkspace(actor:Actor){if(actor.role!=='admin')deny('FORBIDDEN');}
export function checkWorkspaceFirstSend(db:DB,actor:Actor,sessionId:string){
  authorizeWorkspace(actor);
  if(!db.get(`SELECT 1 FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL
    AND lower(p.path)=lower(?)`,[sessionId,FIXED_WORKSPACE_PATH]))deny('NOT_FOUND');
  return !db.get('SELECT 1 FROM messages WHERE session_id=? LIMIT 1',[sessionId]);
}
const scope=(actor:Actor)=>'workspace-dashboard:'+createHash('sha256').update(canonicalJson([actor.id,FIXED_WORKSPACE_PATH])).digest('hex');
const identity=(actor:Actor)=>`${actor.id}:${FIXED_WORKSPACE_PATH}`;
export function readWorkspaceState(db:DB,actor:Actor):StoredWorkspaceState{
  authorizeWorkspace(actor);
  const size=db.get(`SELECT count(*) AS n,coalesce(sum(length(CAST(id AS BLOB))+length(CAST(task_id AS BLOB))+coalesce(length(CAST(session_id AS BLOB)),0)+coalesce(length(CAST(feishu_work_item_id AS BLOB)),0)+coalesce(length(CAST(run_id AS BLOB)),0)),0) AS bytes FROM workspace_console_links WHERE workspace_path=?`,[FIXED_WORKSPACE_PATH])!;
  if(Number(size.n)>1000||Number(size.bytes)>512*1024)deny('PAYLOAD_TOO_LARGE');
  const links=db.all('SELECT * FROM workspace_console_links WHERE workspace_path=? ORDER BY updated_at DESC,id LIMIT 1001',[FIXED_WORKSPACE_PATH]).map(row=>({...row,session_id:row.session_id||null,feishu_work_item_id:row.feishu_work_item_id||null,run_id:row.run_id||null})) as WorkspaceLink[];
  const rows=db.all(`SELECT s.id,substr(s.title,1,200) AS title,s.status,s.updated_at,substr(s.engine,1,32) AS engine,
    substr(coalesce(s.selected_model_id,CASE WHEN s.engine=u.default_engine THEN u.default_model_id END),1,200) AS model,
    (SELECT substr(coalesce(content,''),1,2048) FROM messages m WHERE m.session_id=s.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS latest,
    (SELECT substr(coalesce(content,''),1,512) FROM messages m WHERE m.session_id=s.id AND m.role='user' ORDER BY m.created_at,m.rowid LIMIT 1) AS launch
    FROM sessions s JOIN projects p ON p.id=s.project_id LEFT JOIN users u ON u.id=s.owner_user_id
    WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL AND s.owner_user_id IS NOT NULL AND lower(p.path)=lower(?)
    AND EXISTS(SELECT 1 FROM messages m WHERE m.session_id=s.id) ORDER BY s.updated_at DESC,s.id LIMIT 1001`,[FIXED_WORKSPACE_PATH]);
  if(rows.length>1000)deny('PAYLOAD_TOO_LARGE');
  const sessions=rows.map(row=>{
    const references=new Set(links.filter(link=>link.session_id===row.id&&link.relation_source==='explicit'&&link.confidence==='high').flatMap(link=>{
      const id=link.feishu_work_item_id??feishuWorkItemIdFromTaskId(link.task_id);return id&&/^[1-9]\d*$/.test(id)?[id]:[];
    }));
    const legacy=feishuWorkItemIdFromLaunch(String(row.launch??''));if(legacy)references.add(legacy);
    return projectSessionCard({sessionId:String(row.id),title:String(row.title??''),projectPath:FIXED_WORKSPACE_PATH,updatedAt:Number(row.updated_at??0),status:String(row.status??'unknown'),
      engine:row.engine??null,modelId:row.model??null,latestMessage:row.latest??null,url:`/?session=${encodeURIComponent(String(row.id))}`,feishuWorkItemIds:[...references]});
  });
  const state={sessions,links};canonicalJson(state,1024*1024);return state;
}
export function readWorkspaceDashboard(db:DB,actor:Actor){
  authorizeWorkspace(actor);const key=identity(actor);
  const size=db.get("SELECT length(CAST(data_json AS BLOB)) AS bytes FROM workspace_snapshots WHERE source='dashboard' AND identity_key=?",[key]);if(Number(size?.bytes)>WORKSPACE_DASHBOARD_MAX_BYTES)deny('PAYLOAD_TOO_LARGE');
  const row=db.get("SELECT schema_version,data_json,saved_at FROM workspace_snapshots WHERE source='dashboard' AND identity_key=?",[key]);if(!row||row.schema_version!==1||!Number.isSafeInteger(row.saved_at)||row.saved_at<0)return null;
  let parsed:ReturnType<typeof WorkspaceConsoleDashboardDtoSchema.safeParse>;
  try{parsed=WorkspaceConsoleDashboardDtoSchema.safeParse(JSON.parse(String(row.data_json)));}catch{return null;}
  if(!parsed.success||parsed.data.workspacePath!==FIXED_WORKSPACE_PATH)return null;
  const value=parsed.data,state=readWorkspaceState(db,actor),current=buildWorkspaceDashboard({schemaVersion:null,generatedAt:value.registryGeneratedAt,tasks:value.tasks.map(task=>({...task,description:task.description??null}))},[],state.sessions,state.links,Date.now());
  const sessionIds=new Map(current.tasks.map(task=>[task.id,task.sessionIds]));
  const refreshed=WorkspaceConsoleDashboardDtoSchema.parse({...value,tasks:value.tasks.map(task=>({...task,sessionIds:sessionIds.get(task.id)??[]})),sessions:current.sessions,unlinkedSessions:current.unlinkedSessions,
    counts:{...value.counts,sessions:current.counts.sessions},sourceAvailable:{...value.sourceAvailable,sessions:true,links:true}});
  return{value:refreshed,savedAt:Number(row.saved_at),version:Number(db.get('SELECT latest_applied FROM _relay_storage_observations WHERE scope=?',[scope(actor)])?.latest_applied??0)};
}
export function executeWorkspace(db:DB,actor:Actor,command:Extract<CoreCommand,{name:Name}>){
  authorizeWorkspace(actor);const now=Date.now();
  if(command.name==='workspace.beginSnapshot'){
    db.run('INSERT INTO _relay_storage_observations(scope,latest_issued,latest_applied,snapshot_digest) VALUES(?,1,0,NULL) ON CONFLICT(scope) DO UPDATE SET latest_issued=latest_issued+1',[scope(actor)]);
    const version=Number(db.get('SELECT latest_issued FROM _relay_storage_observations WHERE scope=?',[scope(actor)])!.latest_issued);if(!Number.isSafeInteger(version))deny('CONFLICT');return{version};
  }
  if(command.name==='workspace.saveSnapshot'){
    const {version,value}=command.input;canonicalJson(value,WORKSPACE_DASHBOARD_MAX_BYTES);if(value.workspacePath!==FIXED_WORKSPACE_PATH)deny('INVALID_ARGUMENT');
    const ticket=db.get('SELECT latest_issued,latest_applied,snapshot_digest FROM _relay_storage_observations WHERE scope=?',[scope(actor)]);if(ticket?.latest_issued!==version)deny('SUPERSEDED');
    const json=canonicalJson(value,WORKSPACE_DASHBOARD_MAX_BYTES),digest=createHash('sha256').update(json).digest('hex');
    if(ticket.latest_applied===version){if(ticket.snapshot_digest!==digest)deny('CONFLICT');return{version,savedAt:Number(db.get("SELECT saved_at FROM workspace_snapshots WHERE source='dashboard' AND identity_key=?",[identity(actor)])?.saved_at??now)};}
    db.run("INSERT INTO workspace_snapshots(source,identity_key,schema_version,data_json,saved_at) VALUES('dashboard',?,1,?,?) ON CONFLICT(source,identity_key) DO UPDATE SET schema_version=1,data_json=excluded.data_json,saved_at=excluded.saved_at",[identity(actor),json,now]);
    db.run('UPDATE _relay_storage_observations SET latest_applied=?,snapshot_digest=? WHERE scope=?',[version,digest,scope(actor)]);return{version,savedAt:now};
  }
  const {sessionId,taskId}=command.input;
  const session=db.get(`SELECT s.owner_user_id FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL AND lower(p.path)=lower(?)`,[sessionId,FIXED_WORKSPACE_PATH]);
  if(!session?.owner_user_id)deny('NOT_FOUND');
  if(command.name==='workspace.linkSession'&&!db.get('SELECT 1 FROM messages WHERE session_id=? LIMIT 1',[sessionId]))deny('CONFLICT');
  const audit=(result:'started'|'succeeded')=>appendAdminAuditEventInDatabase(db,{actorUserId:actor.id,action:'session.update',resourceType:'session',resourceId:sessionId,ownerUserId:String(session.owner_user_id),result,occurredAt:now});
  audit('started');
  if(command.name==='workspace.linkSession')insertWorkspaceLinkInOpenTransaction(db,{id:command.input.linkId,workspace_path:FIXED_WORKSPACE_PATH,task_id:taskId,session_id:sessionId,feishu_work_item_id:feishuWorkItemIdFromTaskId(taskId),run_id:null,relation_source:'explicit',confidence:'high',last_verified_at:now,created_at:now,updated_at:now});
  else db.run('DELETE FROM workspace_console_links WHERE workspace_path=? AND task_id=? AND session_id=?',[FIXED_WORKSPACE_PATH,taskId,sessionId]);
  audit('succeeded');return{taskId,sessionId,linked:command.name==='workspace.linkSession'};
}
