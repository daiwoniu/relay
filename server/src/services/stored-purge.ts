import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import type { CoreCommand,CoreStoragePort,PurgeJob,StorageCommandEnvelope,StoragePrincipal,StorageRejectionCode } from '../storage/contracts.js';
import { JournaledUploadQuarantine,QuarantineError } from '../uploads/journaled-quarantine.js';

type Principal=Extract<StoragePrincipal,{kind:'user'}>;
const maintenance={kind:'system' as const,purpose:'maintenance' as const};
const intentSchema=z.object({kind:z.enum(['project','session']),id:z.string().uuid(),impactRevision:z.string().regex(/^[a-f0-9]{64}$/),confirmationName:z.string().min(1).max(100).nullable()}).strict();
export type PurgeIntent=z.infer<typeof intentSchema>;
export type PurgeOutcome={state:'committed';cleanupPending:boolean}|{state:'rejected';code:StorageRejectionCode}|{state:'unknown'};
interface Work {identity:string;result:Promise<PurgeOutcome>;committed:boolean}
const pending=new Map<string,Work>();
const unknown=():PurgeOutcome=>({state:'unknown'});
/** Candidate orchestration only. Exclusive-writer ownership is mandatory; no HTTP/bootstrap binding is installed. */
export class StoredPurge {
  private closed=false;
  private readonly owned=new Set<Promise<PurgeOutcome>>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;
    assertExclusiveWriter:()=>Promise<void>;
    changed:(resource:{kind:'project'|'session';id:string;projectId:string;ownerUserId:string})=>void|Promise<void>;
    timeoutMs?:number;
  }){this.options=Object.freeze({...options});if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>30000))throw new StorageContractError('INVALID_ARGUMENT');}
  delete(principal:Principal,raw:PurgeIntent,key:string):Promise<PurgeOutcome>{
    let actor:Principal,intent:PurgeIntent,jobId:string;
    try{const parsed=parseStoragePrincipal(principal);if(parsed.kind!=='user')throw new Error();actor=parsed;
      intent=intentSchema.parse(JSON.parse(canonicalJson(raw,4096)));key=z.string().uuid().parse(key).toLowerCase();
      const h=createHash('sha256').update(canonicalJson(['purge-job-v1',actor.userId,key])).digest('hex');
      jobId=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
    }catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    return this.admit(jobId,canonicalJson([this.options.generation,actor,intent]),()=>this.performDelete(actor,intent,jobId));
  }
  /** Maintenance may finish a committed job or reject an unfinished one; it never commits a new deletion. */
  recover(jobId:string):Promise<PurgeOutcome>{
    try{jobId=z.string().uuid().parse(jobId).toLowerCase();}catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    return this.admit(jobId,canonicalJson([this.options.generation,'recovery']),()=>this.recoverJob(jobId));
  }
  private async admit(jobId:string,identity:string,work:()=>Promise<PurgeOutcome>):Promise<PurgeOutcome>{
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');
    const key=canonicalJson([this.options.storeId,jobId]);let current=pending.get(key);
    if(current&&current.identity!==identity)return unknown();
    if(!current){if(pending.size>=16)throw new StorageContractError('OVERLOADED');
      const result=Promise.resolve().then(work).catch(error=>error instanceof StorageContractError&&error.code==='FORBIDDEN'?{state:'rejected' as const,code:'FORBIDDEN' as const}:unknown());
      current={identity,result,committed:false};pending.set(key,current);this.owned.add(result);const owned=current;
      void result.finally(()=>{if(pending.get(key)===owned)pending.delete(key);this.owned.delete(result);}).catch(()=>undefined);
    }
    let timer:ReturnType<typeof setTimeout>|undefined;
    const tracked=current;
    try{return await Promise.race([tracked.result,new Promise<PurgeOutcome>(resolve=>{timer=setTimeout(()=>resolve(tracked.committed?{state:'committed',cleanupPending:true}:unknown()),this.options.timeoutMs??10000);timer.unref();})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  async close(){this.closed=true;await Promise.allSettled([...this.owned]);}
  private markCommitted(jobId:string){const work=pending.get(canonicalJson([this.options.storeId,jobId]));if(work)work.committed=true;}
  private async job(jobId:string,principal:StoragePrincipal=maintenance){
    await this.options.assertExclusiveWriter();return this.options.port.readPurgeJob({principal,jobId});
  }
  private async command(jobId:string,suffix:string,principal:StoragePrincipal,command:CoreCommand){
    await this.options.assertExclusiveWriter();
    return executeStoredCommand(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,
      requestId:randomUUID(),operationId:`purge:${jobId}:${suffix}`,principal,command} as StorageCommandEnvelope);
  }
  private matches(job:PurgeJob,intent:PurgeIntent){return job.kind===intent.kind&&job.resourceId===intent.id&&job.request.sourceDigest===intent.impactRevision&&job.confirmationName===intent.confirmationName;}
  private async performDelete(actor:Principal,intent:PurgeIntent,jobId:string):Promise<PurgeOutcome>{
    // Authenticate again before considering an old task; the task's persisted actor is not a fresh login.
    let job=await this.job(jobId,actor);
    if(!job){const result=await this.command(jobId,'register',actor,{name:'trash.preparePurge',input:{jobId,kind:intent.kind,resourceId:intent.id,impactRevision:intent.impactRevision,confirmationName:intent.confirmationName}});
      job=await this.job(jobId);if(!job)return result.state==='rejected'?{state:'rejected',code:result.code}:unknown();}
    if(!this.matches(job,intent))return{state:'rejected',code:'CONFLICT'};
    if(job.phase==='rejected'||job.phase==='committed')return this.settle(job);
    if(job.phase==='reserved'){
      const result=await this.command(jobId,'start',actor,{name:'trash.startPurgeFiles',input:{jobId}});job=await this.job(jobId);if(!job)return unknown();
      if(job.phase==='reserved')return result.state==='rejected'?this.reject(job,result.code):unknown();
    }
    if(job.phase==='isolating'){
      let files;
      try{files=await this.files(job,actor,'prepare');}
      catch(error){if(error instanceof QuarantineError&&['QUARANTINE_OVERLOADED','QUARANTINE_CLOSED'].includes(error.code))return unknown();
        return this.reject(job,'CONFLICT');}
      if(files.state!=='prepared'||!files.intentDigest)return unknown();
      const result=await this.command(jobId,'bind',actor,{name:'trash.bindPurgeProof',input:{jobId,intentDigest:files.intentDigest}});
      job=await this.job(jobId);if(!job)return unknown();
      if(job.phase==='isolating')return result.state==='rejected'?this.reject(job,result.code):unknown();
    }
    if(job.phase==='prepared'){
      if(!job.intentDigest)return unknown();
      const beforeCommit=job;
      const result=await this.command(jobId,'commit',actor,{name:'trash.commitPurge',input:{jobId,intentDigest:job.intentDigest}});
      if(result.state==='committed')this.markCommitted(jobId);
      try{job=await this.job(jobId);}catch{if(result.state==='committed')await this.notify(beforeCommit);return result.state==='committed'?{state:'committed',cleanupPending:true}:unknown();}
      if(!job){if(result.state==='committed')await this.notify(beforeCommit);return result.state==='committed'?{state:'committed',cleanupPending:true}:unknown();}
      if(job.phase==='prepared')return result.state==='rejected'?this.reject(job,result.code):unknown();
    }
    return this.settle(job);
  }
  private async reject(job:PurgeJob,code:StorageRejectionCode):Promise<PurgeOutcome>{
    await this.command(job.jobId,'reject',maintenance,{name:'trash.rejectPurge',input:{jobId:job.jobId}});
    const current=await this.job(job.jobId);if(!current)return unknown();const settled=await this.settle(current);
    return settled.state==='rejected'?{state:'rejected',code}:settled;
  }
  private async recoverJob(jobId:string):Promise<PurgeOutcome>{
    const job=await this.job(jobId);if(!job)return unknown();
    return job.phase==='committed'||job.phase==='rejected'?this.settle(job):this.reject(job,'CONFLICT');
  }
  private async settle(job:PurgeJob):Promise<PurgeOutcome>{
    if(job.phase!=='committed'&&job.phase!=='rejected')return unknown();
    const committed=job.phase==='committed';
    if(committed)this.markCommitted(job.jobId);
    if(committed)await this.notify(job);
    try{
    if(!job.filesFinished){
      if(job.filesStarted){
        let files;try{files=await this.files(job,maintenance,job.phase==='committed'?'reconcile':'rollback');}
        catch{return job.phase==='committed'?{state:'committed',cleanupPending:true}:unknown();}
        if(files.state!==(job.phase==='committed'?'committed':'rolled-back')||!files.intentDigest)return job.phase==='committed'?{state:'committed',cleanupPending:true}:unknown();
        const current=await this.job(job.jobId);if(!current||current.phase!==job.phase||current.intentDigest!==files.intentDigest)return committed?{state:'committed',cleanupPending:true}:unknown();job=current;
      }
      await this.command(job.jobId,'finish-files',maintenance,{name:'trash.finishPurgeFiles',input:{jobId:job.jobId,intentDigest:job.intentDigest}});
      const current=await this.job(job.jobId);if(!current)return committed?{state:'committed',cleanupPending:true}:unknown();job=current;
    }
    if(job.phase==='committed'){
      return{state:'committed',cleanupPending:!job.filesFinished};
    }
    return job.filesFinished?{state:'rejected',code:'CONFLICT'}:unknown();
    }catch{return committed?{state:'committed',cleanupPending:true}:unknown();}
  }
  private async notify(job:PurgeJob){
    try{await this.options.changed({kind:job.kind,id:job.resourceId,projectId:job.projectId,ownerUserId:job.ownerUserId});}
    catch{console.warn('[Purge] 当前删除状态通知暂不可用');}
  }
  private async files(job:PurgeJob,principal:StoragePrincipal,action:'prepare'|'reconcile'|'rollback'){
    const expected=canonicalJson(job.request,256*1024);
    const file=new JournaledUploadQuarantine({timeoutMs:30000,
      assertWriter:async(request)=>{
        const current=await this.job(job.jobId,principal);
        if(!current||current.filesFinished||canonicalJson(current.request,256*1024)!==canonicalJson(request,256*1024)||canonicalJson(request,256*1024)!==expected
          ||(action==='prepare'?current.phase!=='isolating':current.phase!=='committed'&&current.phase!=='rejected'))throw new StorageContractError('CONFLICT');
      },
      resolveDecision:async(request,intentDigest)=>{
        let current=await this.job(job.jobId);if(!current||current.filesFinished||canonicalJson(current.request,256*1024)!==canonicalJson(request,256*1024))return'unknown';
        if(current.phase==='rejected'&&!current.intentDigest){
          await this.command(job.jobId,'bind-rejected',maintenance,{name:'trash.bindPurgeProof',input:{jobId:job.jobId,intentDigest}});current=await this.job(job.jobId);
        }
        if(!current||current.intentDigest!==intentDigest)return'unknown';
        return current.phase==='committed'?'committed':current.phase==='rejected'?'rejected':'unknown';
      }});
    try{return await file.run(job.request,action);}finally{await file.close();}
  }
}
