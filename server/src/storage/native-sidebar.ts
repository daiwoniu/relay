import type { SQLiteDB } from '../db/index.js';
import { MoveSidebarOrderRequestSchema,SidebarOrderDtoSchema,type SidebarOrderScope,type SidebarOrderItemDto } from '../contracts/index.js';
import { getDefaultSidebarOrder,listSidebarOrderScopes,reconcileSidebarOrder,moveSidebarOrderItem } from '../sidebar-order/model.js';
import { StorageContractError } from './command-boundary.js';
import { feishuExecutionActorPattern } from '../integrations/feishu-im/native-session-scope.js';

type DB=Pick<SQLiteDB,'all'|'get'|'run'>;
type Actor={id:string;role:string};
export function authorizeSidebar(db:DB,actor:Actor,scope:SidebarOrderScope){
  if(scope.startsWith('project:')&&!db.get('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL AND (?=1 OR owner_user_id=?)',[scope.slice(8),Number(actor.role==='admin'),actor.id]))throw new StorageContractError('NOT_FOUND');
}
function snapshot(db:DB,actor:Actor){
  // Preserve existing per-account ordering visibility, including the administrator's all-resource view.
  const projects=db.all(`SELECT id,created_at,updated_at,pinned,pinned_at,is_system FROM projects WHERE deleted_at IS NULL AND (?=1 OR owner_user_id=?) LIMIT 501`,[Number(actor.role==='admin'),actor.id]);
  const sessions=db.all(`SELECT s.id,s.created_at,s.updated_at,s.pinned,s.pinned_at,s.archived,s.project_id FROM sessions s JOIN projects p ON p.id=s.project_id
    WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL AND s.owner_user_id NOT GLOB ? AND (?=1 OR s.owner_user_id=?) LIMIT 10001`,
    [feishuExecutionActorPattern,Number(actor.role==='admin'),actor.id]);
  if(projects.length>500||sessions.length>10000)throw new StorageContractError('PAYLOAD_TOO_LARGE');
  return {projects:projects as any[],sessions:sessions as any[]};
}
function order(db:DB,actor:Actor,scope:SidebarOrderScope,state:ReturnType<typeof snapshot>){
  if(scope.startsWith('project:')&&!state.projects.some(project=>project.id===scope.slice(8)))throw new StorageContractError('NOT_FOUND');
  const key=`user:${actor.id}:${scope}`,custom=!!db.get('SELECT 1 FROM sidebar_order_scopes WHERE scope=?',[key]);
  const defaults=getDefaultSidebarOrder(scope,state.projects,state.sessions);
  const stored=custom?db.all('SELECT item_type,item_id FROM sidebar_order_items WHERE scope=? ORDER BY position LIMIT 10001',[key]):[];
  if(stored.length>10000)throw new StorageContractError('PAYLOAD_TOO_LARGE');
  const items=custom?reconcileSidebarOrder(defaults,stored.map(row=>({type:row.item_type,id:row.item_id} as SidebarOrderItemDto))):defaults;
  // Reading never mutates persisted order; reconciliation is committed with the next explicit move.
  return SidebarOrderDtoSchema.parse({scope,custom,items});
}
export function readSidebar(db:DB,actor:Actor){
  const state=snapshot(db,actor);return {orders:listSidebarOrderScopes(state.projects).map(scope=>order(db,actor,scope,state))};
}
export function moveSidebar(db:DB,actor:Actor,input:unknown){
  const parsed=MoveSidebarOrderRequestSchema.safeParse(input);if(!parsed.success)throw new StorageContractError('INVALID_ARGUMENT');
  const current=order(db,actor,parsed.data.scope,snapshot(db,actor));let items:SidebarOrderItemDto[];
  try{items=moveSidebarOrderItem(current.items,parsed.data.item,parsed.data.before);}catch{throw new StorageContractError('INVALID_ARGUMENT');}
  const key=`user:${actor.id}:${current.scope}`;
  db.run('INSERT INTO sidebar_order_scopes(scope,updated_at) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET updated_at=excluded.updated_at',[key,Date.now()]);
  db.run('DELETE FROM sidebar_order_items WHERE scope=?',[key]);
  items.forEach((item,index)=>db.run('INSERT INTO sidebar_order_items(scope,item_type,item_id,position) VALUES(?,?,?,?)',[key,item.type,item.id,index]));
  return SidebarOrderDtoSchema.parse({scope:current.scope,custom:true,items});
}
