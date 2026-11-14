import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import type { CoreCommandName,CoreCommandInputs,CoreStoragePort,SoftDeleteJob,StorageCommandEnvelope,StoragePrincipal,StorageRejectionCode } from '../storage/contracts.js';

type Principal=Extract<StoragePrincipal,{kind:'user'}>;
const maintenance={kind:'system' as const,purpose:'maintenance' as const};
const intentSchema=z.object({kind:z.enum(['project','session']),id:z.string().uuid()}).strict();
export type SoftDeleteIntent=z.infer<typeof intentSchema>;
export type SoftDeleteOutcome={state:'committed'}|{state:'rejected';code:StorageRejectionCode}|{state:'unknown'};
type Failure=Extract<SoftDeleteOutcome,{state:'unknown'|'rejected'}>;
export type SoftDeleteCancelOutcome={state:'cancelled'}|Failure;
type Completion=SoftDeleteOutcome|SoftDeleteCancelOutcome;
const unknown=():Extract<Failure,{state:'unknown'}>=>({state:'unknown'});
// Shared by candidate service instances; an HTTP deadline does not release accepted work.
const pending=new Map<string,{identity:string;result:Promise<Completion>}>();
function parseIntent(principal:Principal,raw:SoftDeleteIntent,key:string){
  const parsed=parseStoragePrincipal(principal);if(parsed.kind!=='user')throw new Error();
  const intent=intentSchema.parse(JSON.parse(canonicalJson(raw,4096)));key=z.string().uuid().parse(key).toLowerCase();
  const h=createHash('sha256').update(canonicalJson(['soft-delete-job-v1',parsed.userId,key])).digest('hex');
  return{actor:parsed,intent,jobId:`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`};
}
/** Recovery never archives or commits a new deletion. Only explicit cancellation plans may restore threads. */
export class StoredSoftDelete {
  private closed=false;
  private readonly owned=new Set<Promise<unknown>>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>;
    /** Fresh complete uncached provider observation; null is not evidence of absence. */
    isThreadArchived:(threadId:string)=>Promise<boolean|null>;
    /** Must check mayDispatch after connection setup and immediately before the single provider write. */
    archiveThread:(threadId:string,mayDispatch:()=>Promise<boolean>)=>Promise<void|{wasAlreadyArchived:boolean}>;
    /** Successful resolution must acknowledge the completed provider RPC; recheck mayDispatch immediately before it. */
    restoreThread?:(threadId:string,mayDispatch:()=>Promise<boolean>)=>Promise<void>;
    /** Capture the runtime instance and recheck it after mayClose before closing an idle connection. */
    closeIdleConnection:(sessionId:string,threadId:string,mayClose:()=>Promise<boolean>)=>void|Promise<void>;
    changed:(resource:{kind:'project'|'session';id:string;projectId:string;ownerUserId:string})=>void|Promise<void>;
    timeoutMs?:number;providerTimeoutMs?:number;
  }){
    this.options=Object.freeze({...options});
    for(const value of [options.timeoutMs,options.providerTimeoutMs])if(value!==undefined&&(!Number.isSafeInteger(value)||value<1||value>30000))throw new StorageContractError('INVALID_ARGUMENT');
  }
  delete(principal:Principal,raw:SoftDeleteIntent,key:string):Promise<SoftDeleteOutcome>{
    let actor:Principal,intent:SoftDeleteIntent,jobId:string;
    try{
      ({actor,intent,jobId}=parseIntent(principal,raw,key));
    }catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    return this.admit(jobId,canonicalJson([this.options.generation,actor,intent]),()=>this.perform(actor,intent,jobId));
  }
  /** Unknown original dispatches remain fenced; only attributable, settled archives can enter compensation. */
  cancel(principal:Principal,raw:SoftDeleteIntent,key:string):Promise<SoftDeleteCancelOutcome>{
    let parsed:ReturnType<typeof parseIntent>;
    try{parsed=parseIntent(principal,raw,key);}catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    const {actor,intent,jobId}=parsed;
    return this.admit<SoftDeleteCancelOutcome>(jobId,canonicalJson([this.options.generation,'cancel',actor,intent]),async()=>{
      let job=await this.job(jobId,actor);if(!job)return{state:'rejected',code:'NOT_FOUND'};
      if(job.kind!==intent.kind||job.resourceId!==intent.id||job.phase==='committed')return{state:'rejected',code:'CONFLICT'};
      if(job.phase==='abandoned')return{state:'cancelled'};
      if(job.phase==='prepared'){
        await this.command(jobId,actor,{name:'trash.abandonSoftDelete',input:{jobId}},'cancel');
        job=await this.job(jobId,actor);if(job?.phase==='abandoned')return{state:'cancelled'};
        await this.command(jobId,actor,{name:'trash.beginSoftDeleteCancel',input:{jobId}},'cancel-plan');
      }
      return this.compensate(jobId,actor);
    });
  }
  recover(jobId:string):Promise<SoftDeleteOutcome>{
    try{jobId=z.string().uuid().parse(jobId).toLowerCase();}catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    return this.admit(jobId,canonicalJson([this.options.generation,'recover']),()=>this.reconcile(jobId));
  }
  recoverCancellation(jobId:string):Promise<SoftDeleteCancelOutcome>{
    try{jobId=z.string().uuid().parse(jobId).toLowerCase();}catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    return this.admit<SoftDeleteCancelOutcome>(jobId,canonicalJson([this.options.generation,'recover-cancel']),()=>this.compensate(jobId,maintenance));
  }
  private async admit<T extends Completion>(jobId:string,identity:string,work:()=>Promise<T>):Promise<T|Failure>{
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');
    const key=canonicalJson([this.options.storeId,jobId]);let item=pending.get(key);
    if(item&&item.identity!==identity)return unknown();
    if(!item){
      if(pending.size>=16)throw new StorageContractError('OVERLOADED');
      const result=Promise.resolve().then(work).catch(error=>error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND'].includes(error.code)
        ?{state:'rejected' as const,code:error.code}:unknown());
      item={identity,result};pending.set(key,item);this.owned.add(result);const tracked=item;
      void result.finally(()=>{if(pending.get(key)===tracked)pending.delete(key);this.owned.delete(result);}).catch(()=>undefined);
    }
    // Identity includes operation mode, current principal and exact target; only matching callers share this result type.
    return this.deadline(()=>item!.result as Promise<T|Failure>,this.options.timeoutMs??10000).catch(()=>unknown());
  }
  async close(){this.closed=true;await Promise.allSettled([...this.owned]);}
  private async deadline<T>(work:()=>T|Promise<T>,ms=this.options.providerTimeoutMs??10000):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([Promise.resolve().then(work),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('EXTERNAL_DEADLINE')),ms);timer.unref();})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  private async job(jobId:string,principal:StoragePrincipal){
    await this.options.assertExclusiveWriter();return this.options.port.readSoftDeleteJob({principal,jobId});
  }
  private async command<K extends CoreCommandName>(jobId:string,principal:StoragePrincipal,command:{name:K;input:CoreCommandInputs[K]},suffix:string=randomUUID()){
    await this.options.assertExclusiveWriter();
    return executeStoredCommand<K>(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,
      requestId:randomUUID(),operationId:`soft-delete:${jobId}:${suffix}`,principal,command} as unknown as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}});
  }
  private async observe(threadId:string){try{return await this.deadline(()=>this.options.isThreadArchived(threadId));}catch{return null;}}
  private async compensate(jobId:string,principal:StoragePrincipal):Promise<SoftDeleteCancelOutcome>{
    let job=await this.job(jobId,principal);if(!job)return unknown();if(job.phase==='abandoned')return{state:'cancelled'};if(job.phase!=='cancelling')return unknown();
    for(const effect of job.compensations){
      if(this.closed)return unknown();if(effect.phase==='confirmed')continue;
      // A target-state observation cannot prove that a previously dispatched RPC will not arrive later.
      if(effect.phase==='dispatched')return unknown();
      const archived=await this.observe(effect.threadId);if(archived===null||archived&&!this.options.restoreThread)return unknown();
      const token=randomUUID(),claim=await this.command(jobId,principal,{name:'trash.claimTrashRestore',input:{jobId,threadId:effect.threadId,observedUnarchived:!archived,claimToken:token}});
      job=await this.job(jobId,principal);if(job?.compensations.find(e=>e.threadId===effect.threadId)?.phase==='confirmed')continue;
      if(claim.state!=='committed'||!claim.value.claimed||claim.value.claimToken!==token)return unknown();
      let active=true,acknowledged=false;const expires=Date.now()+(this.options.providerTimeoutMs??10000);
      const mayDispatch=async()=>{
        if(!active||this.closed||Date.now()>=expires)return false;await this.options.assertExclusiveWriter();
        const allowed=await this.options.port.checkTrashRestoreDispatch({principal,jobId,threadId:effect.threadId,claimToken:token});return active&&!this.closed&&Date.now()<expires&&allowed;
      };
      try{if(await mayDispatch()){
        await this.deadline(()=>this.options.restoreThread!(effect.threadId,mayDispatch));acknowledged=true;
      }}catch{/* No successful acknowledgement: never release the scope based on observation alone. */}finally{active=false;}
      if(!acknowledged||await this.observe(effect.threadId)!==false)return unknown();
      await this.command(jobId,principal,{name:'trash.confirmTrashRestore',input:{jobId,threadId:effect.threadId,observedUnarchived:true,providerAcknowledged:true,claimToken:token}});
      if((await this.job(jobId,principal))?.compensations.find(e=>e.threadId===effect.threadId)?.phase!=='confirmed')return unknown();
    }
    if(this.closed)return unknown();await this.command(jobId,principal,{name:'trash.finishSoftDeleteCancel',input:{jobId}},'cancel-finish');
    return(await this.job(jobId,principal))?.phase==='abandoned'?{state:'cancelled'}:unknown();
  }
  private async confirm(jobId:string,threadId:string,principal:StoragePrincipal,evidence:{kind:'provider-reply';wasAlreadyArchived:boolean}|{kind:'fresh-observation';archived:true}){
    await this.command(jobId,principal,{name:'trash.confirmTrashArchive',input:{jobId,threadId,evidence}});
    return (await this.job(jobId,principal))?.archives.find(e=>e.threadId===threadId)?.phase==='confirmed';
  }
  private async archive(jobId:string,threadId:string,actor:Principal):Promise<boolean>{
    // Claim ID and capability are private per in-memory attempt, never stable HTTP keys.
    const archived=await this.observe(threadId);if(archived===null||this.closed)return false;
    const token=randomUUID(),claim=await this.command(jobId,actor,{name:'trash.claimTrashArchive',input:{jobId,threadId,observedArchived:archived,claimToken:token}});
    let job=await this.job(jobId,actor),effect=job?.archives.find(e=>e.threadId===threadId);
    if(effect?.phase==='confirmed')return true;
    if(claim.state==='committed'&&claim.value.claimed&&claim.value.claimToken===token){
      let active=true;const expires=Date.now()+(this.options.providerTimeoutMs??10000);
      const mayDispatch=async()=>{
        if(!active||this.closed||Date.now()>=expires)return false;
        await this.options.assertExclusiveWriter();
        const allowed=await this.options.port.checkTrashArchiveDispatch({principal:actor,jobId,threadId,claimToken:token});
        return active&&!this.closed&&Date.now()<expires&&allowed;
      };
      let reply:void|{wasAlreadyArchived:boolean}=undefined;
      try{if(await mayDispatch())reply=await this.deadline(()=>this.options.archiveThread(threadId,mayDispatch));}
      catch{/* A provider write may have happened; its durable right is never reclaimed. */}
      finally{active=false;}
      if(reply&&typeof reply.wasAlreadyArchived==='boolean'&&await this.confirm(jobId,threadId,actor,{kind:'provider-reply',wasAlreadyArchived:reply.wasAlreadyArchived}))return true;
    }
    job=await this.job(jobId,actor);effect=job?.archives.find(e=>e.threadId===threadId);
    if(effect?.phase==='confirmed')return true;
    if(effect?.phase==='dispatched'&&await this.observe(threadId)===true)
      return this.confirm(jobId,threadId,actor,{kind:'fresh-observation',archived:true});
    return false;
  }
  private async perform(actor:Principal,intent:SoftDeleteIntent,jobId:string):Promise<SoftDeleteOutcome>{
    let job=await this.job(jobId,actor);
    if(!job){
      if(this.closed)return unknown();
      const result=await this.command(jobId,actor,{name:'trash.prepareSoftDelete',input:{jobId,kind:intent.kind,resourceId:intent.id,archiveCodex:false}},'prepare');
      job=await this.job(jobId,actor);if(!job)return result.state==='rejected'?{state:'rejected',code:result.code}:unknown();
    }
    if(job.kind!==intent.kind||job.resourceId!==intent.id)return{state:'rejected',code:'CONFLICT'};
    if(job.phase==='abandoned')return{state:'rejected',code:'CONFLICT'};
    if(job.phase==='cancelling')return unknown();
    if(job.phase==='committed')return this.complete(actor,job);
    try{
    for(const effect of job.archives){
      if(this.closed)return unknown();
      if(effect.phase==='confirmed')continue;
      if(effect.phase==='dispatched'){
        if(await this.observe(effect.threadId)!==true||!await this.confirm(jobId,effect.threadId,actor,{kind:'fresh-observation',archived:true}))return unknown();
      }else if(!await this.archive(jobId,effect.threadId,actor))return unknown();
    }
    if(this.closed)return unknown();
    const result=await this.command(jobId,actor,{name:'trash.commitSoftDelete',input:{jobId}},'commit');
    job=await this.job(jobId,actor);
    if(job?.phase==='committed')return this.complete(actor,job);
    // Once any provider write was dispatched, a local rejection is not a completed rollback.
    if(result.state==='rejected'&&job&&!job.archives.some(e=>e.phase==='dispatched'||e.restoreOnRecovery))return{state:'rejected',code:result.code};
    return unknown();
    }catch{return unknown();} // A post-registration failure cannot certify compensation of a provider write.
  }
  private async complete(actor:Principal,job:SoftDeleteJob):Promise<SoftDeleteOutcome>{
    const cleanup=this.finishLocalEffects(actor,job);
    if(job.archives.length===0){
      // Local deletion is authoritative. Notification/idle transport cleanup cannot delay success.
      this.owned.add(cleanup);void cleanup.finally(()=>this.owned.delete(cleanup)).catch(()=>undefined);
    }else await cleanup; // Previously accepted archive jobs retain their original recovery semantics.
    return{state:'committed'};
  }
  private async finishLocalEffects(actor:Principal,job:SoftDeleteJob):Promise<void>{
    try{await this.deadline(()=>this.options.changed({kind:job.kind,id:job.resourceId,projectId:job.projectId,ownerUserId:job.ownerUserId}));}catch{/* Persistence is authoritative. */}
    for(const target of job.targets){
      if(target.alreadyDeleted||!target.threadId||this.closed)continue;
      const threadId=target.threadId;
      let active=true;const expires=Date.now()+(this.options.providerTimeoutMs??10000);
      try{await this.deadline(()=>this.options.closeIdleConnection(target.sessionId,threadId,async()=>{
        if(!active||this.closed||Date.now()>=expires)return false;await this.options.assertExclusiveWriter();
        const allowed=await this.options.port.checkSoftDeleteClose({principal:actor,jobId:job.jobId,sessionId:target.sessionId,threadId});
        return active&&!this.closed&&Date.now()<expires&&allowed;
      }));}catch{/* Current runtime/source may have changed. Never close it without proof. */}finally{active=false;}
    }
  }
  private async reconcile(jobId:string):Promise<SoftDeleteOutcome>{
    const job=await this.job(jobId,maintenance);if(!job)return unknown();
    if(job.phase==='committed')return{state:'committed'};
    if(job.phase==='abandoned')return{state:'rejected',code:'CONFLICT'};
    if(job.phase==='cancelling')return unknown();
    for(const effect of job.archives)if(effect.phase==='dispatched'&&await this.observe(effect.threadId)===true)
      await this.confirm(jobId,effect.threadId,maintenance,{kind:'fresh-observation',archived:true});
    // A recovered task still requires an authenticated user's explicit commit. No implicit cancellation either.
    return unknown();
  }
}
