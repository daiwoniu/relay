import { createHash,randomUUID } from 'node:crypto';
import type { CoreStoragePort,StoragePrincipal,StorageCommandEnvelope,TrashRestoreResult } from '../storage/contracts.js';
import { StorageContractError,canonicalJson } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { TrashRestoreResponseDtoSchema,type TrashRestoreResponseDto } from '../contracts/index.js';
import type { StoredUnarchiveService } from './stored-unarchive.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;
type Outcome={state:'committed';value:TrashRestoreResponseDto}|{state:'unknown';localCommitted:boolean};
export class RestoreDirectoryUnavailable extends Error{constructor(){super('TRASH_PROJECT_PATH_UNAVAILABLE');}}
interface Job{result:Promise<Outcome>;localCommitted:boolean}
/** Local restoration is authoritative before external reconciliation. Timeouts retain ownership of accepted work. */
export class StoredTrash {
  private closed=false;
  private readonly jobs=new Map<string,Job>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;
    verifyDirectory:(projectPath:string)=>Promise<void>;
    unarchive:Pick<StoredUnarchiveService,'run'>;
    projectChanged:(id:string)=>void|Promise<void>;sessionChanged:(id:string)=>void|Promise<void>;sidebarChanged:()=>void|Promise<void>;
    timeoutMs?:number;
  }){
    this.options=Object.freeze({...options});if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>30000))throw new StorageContractError('INVALID_ARGUMENT');
  }
  restore(principal:Principal,kind:'project'|'session',id:string,key:string):Promise<Outcome>{
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    const actor=structuredClone(principal),identity=canonicalJson([actor,kind,id,key]);let job=this.jobs.get(identity);
    if(!job){
      if(this.jobs.size>=16)return Promise.reject(new StorageContractError('OVERLOADED'));
      const fresh:Job={result:Promise.resolve({state:'unknown',localCommitted:false}),localCommitted:false};job=fresh;this.jobs.set(identity,fresh);
      fresh.result=Promise.resolve().then(()=>this.perform(actor,kind,id,key,()=>{fresh.localCommitted=true;})).finally(()=>{if(this.jobs.get(identity)===fresh)this.jobs.delete(identity);});
      void fresh.result.catch(()=>undefined);
    }
    const tracked=job;let timer:ReturnType<typeof setTimeout>|undefined;
    return Promise.race([tracked.result,new Promise<Outcome>((resolve)=>{timer=setTimeout(()=>resolve({state:'unknown',localCommitted:tracked.localCommitted}),this.options.timeoutMs??10000);timer.unref();})]).finally(()=>{if(timer)clearTimeout(timer);});
  }
  private async notify(value:TrashRestoreResult){
    const effects:Array<()=>void|Promise<void>>=[()=>this.options.sidebarChanged(),...(value.kind==='project'?[()=>this.options.projectChanged(value.projectId)]:[]),...value.sessionIds.map((id)=>()=>this.options.sessionChanged(id))];
    for(let index=0;index<effects.length;index+=16){const results=await Promise.allSettled(effects.slice(index,index+16).map(fn=>Promise.resolve().then(fn)));
      if(results.some(r=>r.status==='rejected'))console.warn('[Trash] 当前恢复状态通知暂不可用');}
  }
  private async complete(principal:Principal,value:TrashRestoreResult,operationId:string):Promise<Outcome>{
    const projection=value.kind==='project'?await this.options.port.readProject({principal,projectId:value.resourceId}):await this.options.port.readSession({principal,sessionId:value.resourceId});
    if(!projection)return {state:'unknown',localCommitted:true};
    const groups=new Map<string,Array<{sessionId:string;threadId:string}>>();for(const candidate of value.unarchive){const list=groups.get(candidate.threadId)??[];list.push(candidate);groups.set(candidate.threadId,list);}
    let confirmed=0,uncertain=false,stop=false;const iterator=[...groups.values()][Symbol.iterator]();
    const consume=async()=>{
      for(let next=iterator.next();!next.done&&!stop;next=iterator.next()){
        let first=true;
        for(const candidate of next.value){
          const key='restore:'+createHash('sha256').update(canonicalJson([operationId,candidate.sessionId])).digest('hex');
          try{const result=await this.options.unarchive.run(principal,candidate.sessionId,key,candidate.threadId,!first);if(result.state==='committed')confirmed++;else uncertain=true;}
          catch(error){uncertain=true;if(error instanceof StorageContractError&&error.code==='FORBIDDEN'){stop=true;break;}}
          first=false;
        }
      }
    };
    await Promise.all([consume(),consume()]);await this.notify(value);
    if(uncertain||confirmed!==value.unarchive.length)return {state:'unknown',localCommitted:true};
    return {state:'committed',value:TrashRestoreResponseDtoSchema.parse({ok:true,restoredSessionCount:value.sessionIds.length,unarchivedSessionCount:confirmed,unarchiveFailedSessionCount:0,archiveStateSyncFailedSessionCount:0})};
  }
  private async perform(principal:Principal,kind:'project'|'session',id:string,key:string,onLocal:()=>void):Promise<Outcome>{
    const operationId=`trash:${createHash('sha256').update(principal.userId).digest('hex').slice(0,32)}:${kind}:${key}`;
    const prior=await this.options.port.lookup({storeId:this.options.storeId,operationId,principal});
    if(prior.state==='committed'){
      if(prior.commandName!=='trash.restoreProject'&&prior.commandName!=='trash.restoreSession')throw new StorageContractError('CONFLICT');
      if(prior.value.kind!==kind||prior.value.resourceId!==id)throw new StorageContractError('CONFLICT');
      onLocal();return this.complete(principal,prior.value,operationId).catch(()=>({state:'unknown',localCommitted:true}));
    }
    if(prior.state==='expired')throw new StorageContractError('OPERATION_EXPIRED');if(prior.state!=='not-found')return {state:'unknown',localCommitted:false};
    const plan=await this.options.port.readTrash({principal,name:'restorePlan',input:{kind,id}});
    if(kind==='project')try{await this.options.verifyDirectory(plan.projectPath);}catch{throw new RestoreDirectoryUnavailable();}
    const command=kind==='project'?{name:'trash.restoreProject' as const,input:{projectId:id,sourceDigest:plan.sourceDigest}}:{name:'trash.restoreSession' as const,input:{sessionId:id,sourceDigest:plan.sourceDigest}};
    const request={protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),operationId,principal,command} as StorageCommandEnvelope&{command:typeof command};
    const result=await executeStoredCommand(this.options.port,request);
    if(result.state==='rejected')throw new StorageContractError(result.code);if(result.state!=='committed')return {state:'unknown',localCommitted:false};
    onLocal();return this.complete(principal,result.value as TrashRestoreResult,operationId).catch(()=>({state:'unknown',localCommitted:true}));
  }
  async close(){this.closed=true;await Promise.allSettled([...this.jobs.values()].map(job=>job.result));}
}
