import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkspaceConsoleDashboardDtoSchema,WorkspaceTaskSessionLinkResponseDtoSchema } from '../contracts/index.js';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import type { CoreCommandName,CoreCommandInputs,CoreStoragePort,StorageCommandEnvelope,StoragePrincipal,StoredWorkspaceDashboard } from '../storage/contracts.js';
import { buildWorkspaceDashboard,WORKSPACE_DASHBOARD_MAX_BYTES } from './dashboard-projection.js';
import type { TaskRegistryProjection } from './task-registry-reader.js';
import type { WorkspaceRunProjection } from './run-projection.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';
import { feishuWorkItemIdFromTaskId } from './task-reference.js';
import { ServiceError } from '../services/errors.js';
import type { WorkspaceResponsibilitySnapshot } from './responsibility-report-source.js';
import { WORKSPACE_ID, WORKSPACE_CONNECTION_SCOPE } from './workspace-context.js';
import { parseFeishuTarget } from './task-reference.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;
/** Candidate facade: filesystem/network sources stay outside the Worker; authoritative sessions/links are always refreshed. */
export class StoredWorkspaceConsole{
  private closed=false;private readonly pending=new Set<Promise<unknown>>();
  private readonly cacheStatus=new Map<string,{version:number;failure:{at:number;error:string;available:StoredWorkspaceDashboard['sourceAvailable']}|null}>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;registry:()=>Promise<TaskRegistryProjection>;listRuns:()=>Promise<WorkspaceRunProjection[]>;
    activityDurations:(taskIds:string[],now:number)=>Promise<Map<string,number>|import('./activity-duration.js').ObservedActivity>;hasFeishuWorkItem?:(actor:Principal,id:string)=>Promise<boolean>;
    verifyFeishuTarget?:(reference:string)=>Promise<boolean>;allowLocalFeishuLinks?:boolean;
    composeResponsibility?:(value:WorkspaceResponsibilitySnapshot,taskId?:string)=>Promise<WorkspaceResponsibilitySnapshot>}){this.options=Object.freeze({...options});}
  composeResponsibility(value:Omit<WorkspaceResponsibilitySnapshot,'servedFromCache'> & {servedFromCache?:boolean},taskId?:string){
    const snapshot={...value,servedFromCache:value.servedFromCache??false};
    return this.options.composeResponsibility?.(snapshot,taskId)??Promise.resolve(snapshot);
  }
  private actor(principal:Principal){const actor=parseStoragePrincipal(principal);if(actor.kind!=='user')throw new StorageContractError('FORBIDDEN');return actor;}
  private track<T>(work:()=>Promise<T>):Promise<T>{
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));if(this.pending.size>=16)return Promise.reject(new StorageContractError('OVERLOADED'));
    const result=Promise.resolve().then(work);this.pending.add(result);void result.finally(()=>this.pending.delete(result)).catch(()=>undefined);return result;
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending]);this.cacheStatus.clear();}
  private async assertTask(actor:Principal,taskId:string){
    const feishuId=feishuWorkItemIdFromTaskId(taskId);
    if(feishuId){if(!await this.options.hasFeishuWorkItem?.(actor,taskId)&&!await this.options.verifyFeishuTarget?.(taskId))throw new StorageContractError('NOT_FOUND');return;}
    const registry=await this.options.registry();if(!registry.tasks.some(task=>task.id===taskId))throw new StorageContractError('NOT_FOUND');
  }
  prepareFirstSendLink(principal:Principal,taskId:string,sessionId:string,workspaceId='default'){
    const actor=this.actor(principal);taskId=z.string().trim().min(1).max(128).parse(taskId);sessionId=z.string().uuid().parse(sessionId);
    return this.track(async()=>{
      const access=await this.options.port.readFrontendAccess({principal:actor,resource:{kind:'session',id:sessionId}});
      if(!access?.allowed||access.user.role!=='admin'||access.user.mustChangePassword||access.expiresAt<=Date.now())throw new StorageContractError('FORBIDDEN');
      if(workspaceId!==WORKSPACE_ID)throw new StorageContractError('CONFLICT');
      await this.assertTask(actor,taskId);
      if(!await this.options.port.checkWorkspaceFirstSend({principal:actor,sessionId}))throw new StorageContractError('CONFLICT');
      const fresh=await this.options.port.readFrontendAccess({principal:actor,resource:{kind:'session',id:sessionId}});
      if(this.closed||!fresh?.allowed||fresh.user.role!=='admin'||fresh.user.mustChangePassword||fresh.expiresAt<=Date.now())throw new StorageContractError('FORBIDDEN');
      const targetRef=parseFeishuTarget(taskId)?taskId:'';
      return{taskId,workspacePath:FIXED_WORKSPACE_PATH,workspaceId:WORKSPACE_ID,...(targetRef?{targetRef,connectionScope:WORKSPACE_CONNECTION_SCOPE}:{})};
    });
  }
  private command<K extends CoreCommandName>(principal:Principal,key:string,name:K,input:CoreCommandInputs[K]){
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');
    return executeStoredCommand<K>(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),
      operationId:`workspace:${createHash('sha256').update(principal.userId).digest('hex').slice(0,32)}:${key}`,principal,command:{name,input}} as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}});
  }
  getDashboard(principal:Principal,force=false):Promise<StoredWorkspaceDashboard>{
    const actor=this.actor(principal);return this.track(async()=>{
      const previous=await this.options.port.readWorkspaceDashboard({principal:actor});
      const failure=this.cacheStatus.get(actor.userId)?.failure;
      if(previous&&!force)return{...previous.value,...(failure?{errors:[...new Set([...previous.value.errors,failure.error])],sourceAvailable:failure.available}:{}),
        sourceMeta:{state:failure?'failed_snapshot':'snapshot',lastSuccessAt:previous.savedAt,lastAttemptAt:failure?.at??null,error:failure?.error??null}};
      const key=randomUUID(),ticket=await this.command(actor,key+':begin','workspace.beginSnapshot',{});
      if(ticket.state!=='committed')throw new StorageContractError(ticket.state==='rejected'?ticket.code:'STORAGE_UNAVAILABLE');
      if(!this.cacheStatus.has(actor.userId)&&this.cacheStatus.size>=128)this.cacheStatus.delete(this.cacheStatus.keys().next().value!);
      const status=this.cacheStatus.get(actor.userId)??{version:0,failure:null};status.version=Math.max(status.version,ticket.value.version);this.cacheStatus.set(actor.userId,status);
      const loaded=await Promise.allSettled([this.options.registry(),this.options.listRuns()]);const errors:string[]=[];
      const rawRegistry=loaded[0].status==='fulfilled'?loaded[0].value:{schemaVersion:null,generatedAt:null,tasks:[]};
      const registry={...rawRegistry,tasks:rawRegistry.tasks.map(task=>({...task,description:task.description??null,startedAt:task.startedAt??null,completedAt:task.completedAt??null}))};if(loaded[0].status==='rejected'){
        const error=loaded[0].reason;
        errors.push(error instanceof ServiceError&&['WORKSPACE_CONFIG_REQUIRED','WORKSPACE_CONFIG_INVALID','WORKSPACE_FILE_MISSING'].includes(error.code??'')?error.message:'当前任务台账读取失败');
      }
      const runs=loaded[1].status==='fulfilled'?loaded[1].value:[];if(loaded[1].status==='rejected')errors.push('当前运行记录读取失败');
      let activity=new Map<string,number>(),evidence=new Map<string,import('./activity-duration.js').ActivityEvidence>(),activityAvailable=true;const capturedAt=Date.now();
      try{const observed=await this.options.activityDurations(registry.tasks.map(task=>task.id),capturedAt);if(observed instanceof Map)activity=observed;else{activity=observed.durations;evidence=observed.evidence;}}catch{errors.push('当前活动用时读取失败');activityAvailable=false;}
      const state=await this.options.port.readWorkspaceState({principal:actor});
      const value=WorkspaceConsoleDashboardDtoSchema.parse({...buildWorkspaceDashboard(registry,runs,state.sessions,state.links,capturedAt,errors,
        {registry:loaded[0].status==='fulfilled',runs:loaded[1].status==='fulfilled',sessions:true,links:true,activity:activityAvailable},activity,evidence),
        sourceMeta:{state:errors.length?'unavailable':'live',lastSuccessAt:errors.length?null:capturedAt,lastAttemptAt:capturedAt,error:errors.length?errors.join('；'):null}});
      canonicalJson(value,WORKSPACE_DASHBOARD_MAX_BYTES);
      if(errors.length){
        if(status.version===ticket.value.version)status.failure={at:capturedAt,error:errors.join('；'),available:value.sourceAvailable};
        const current=await this.options.port.readWorkspaceDashboard({principal:actor});
        return current?{...current.value,errors:[...current.value.errors,...errors],sourceAvailable:{...current.value.sourceAvailable,...value.sourceAvailable},
          sourceMeta:{state:'failed_snapshot',lastSuccessAt:current.savedAt,lastAttemptAt:capturedAt,error:errors.join('；')}}:value;
      }
      const saved=await this.command(actor,key+':save','workspace.saveSnapshot',{version:ticket.value.version,value});
      const current=await this.options.port.readWorkspaceDashboard({principal:actor});
      if(current&&(current.version>=ticket.value.version||saved.state==='rejected'&&saved.code==='SUPERSEDED')){if(current.version>=status.version){status.version=current.version;status.failure=null;}return current.value;}
      throw new StorageContractError(saved.state==='rejected'?saved.code:'STORAGE_UNAVAILABLE');
    });
  }
  link(principal:Principal,taskId:string,sessionId:string,key:string,linked:boolean,targetRef=''){
    const actor=this.actor(principal);taskId=z.string().trim().min(1).max(128).parse(taskId);sessionId=z.string().uuid().parse(sessionId);key=z.string().uuid().parse(key).toLowerCase();
    return this.track(async()=>{
      const access=await this.options.port.readFrontendAccess({principal:actor,resource:null});if(!access||access.user.role!=='admin'||access.user.mustChangePassword||access.expiresAt<=Date.now())throw new StorageContractError('FORBIDDEN');
      if(!targetRef&&parseFeishuTarget(taskId))targetRef=taskId;
      if(targetRef&&!parseFeishuTarget(targetRef))throw new StorageContractError('INVALID_ARGUMENT');
      if(linked&&targetRef&&targetRef!==taskId&&!this.options.allowLocalFeishuLinks)throw new StorageContractError('INVALID_ARGUMENT');
      if(linked){await this.assertTask(actor,taskId);if(targetRef&&targetRef!==taskId)await this.assertTask(actor,targetRef);}
      const h=createHash('sha256').update(canonicalJson([actor.userId,key])).digest('hex'),linkId=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
      const scoped={taskId,sessionId,workspaceId:WORKSPACE_ID,...(targetRef?{targetRef,connectionScope:WORKSPACE_CONNECTION_SCOPE}:{targetRef:''})};
      const result=linked?await this.command(actor,key,'workspace.linkSession',{linkId,...scoped}):await this.command(actor,key,'workspace.unlinkSession',scoped);
      if(result.state!=='committed')throw new StorageContractError(result.state==='rejected'?result.code:'STORAGE_UNAVAILABLE');
      // The receipt establishes the write; the target is rechecked when current dashboard state is requested.
      return WorkspaceTaskSessionLinkResponseDtoSchema.parse(result.value);
    });
  }
}
