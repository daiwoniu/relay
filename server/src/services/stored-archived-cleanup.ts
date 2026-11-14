import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CoreCommand,CoreStoragePort,StoragePrincipal,StorageRejectionCode,UploadCleanupJob,UploadReadScope } from '../storage/contracts.js';
import type { ProjectUploadUsageDto } from '../contracts/index.js';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { ArchivedUploadCleanup,type ArchivedCleanupResult } from '../uploads/archived-upload-cleanup.js';
import { ProjectFileActivities } from '../uploads/project-file-activities.js';
import { StoredUploadReads } from './stored-upload-reads.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;
const maintenance={kind:'system' as const,purpose:'maintenance' as const};
const intentSchema=z.object({projectId:z.string().uuid().transform(v=>v.toLowerCase()),attachmentIds:z.array(z.string().uuid().transform(v=>v.toLowerCase())).min(1).max(10).refine(v=>new Set(v).size===v.length).transform(v=>v.sort()).nullable()}).strict();
export type ArchivedCleanupIntent=z.input<typeof intentSchema>;
export type StoredArchivedCleanupOutcome={state:'committed';deletedCount:number;cleanupPending:boolean;usage:ProjectUploadUsageDto|null}|{state:'rejected';code:StorageRejectionCode;rollbackPending:boolean}|{state:'access-denied';code:'FORBIDDEN'|'NOT_FOUND'}|{state:'unknown'};
const pending=new Map<string,{identity:string;result:Promise<StoredArchivedCleanupOutcome>}>();
const unknown=():StoredArchivedCleanupOutcome=>({state:'unknown'});
const rejected=(code:StorageRejectionCode,rollbackPending=false):StoredArchivedCleanupOutcome=>({state:'rejected',code,rollbackPending});
const accessDenied=(code:StorageRejectionCode):StoredArchivedCleanupOutcome=>({state:'access-denied',code:code==='NOT_FOUND'?'NOT_FOUND':'FORBIDDEN'});
const committed=(job:UploadCleanupJob):StoredArchivedCleanupOutcome=>({state:'committed',deletedCount:job.deletedCount??0,cleanupPending:!job.filesFinished,usage:null});
export class StoredArchivedCleanup{
  private closed=false;private readonly owned=new Set<Promise<StoredArchivedCleanupOutcome>>();private readonly reads:StoredUploadReads;
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;files:ProjectFileActivities;assertExclusiveWriter:()=>Promise<void>;changed:(projectId:string)=>void|Promise<void>}){
    this.options=Object.freeze({...options});if(!options.storeId||!Number.isSafeInteger(options.generation)||options.generation<1)throw new StorageContractError('INVALID_ARGUMENT');this.reads=new StoredUploadReads({port:options.port,activity:scope=>options.files.snapshot(scope)});
  }
  delete(raw:Principal,rawIntent:ArchivedCleanupIntent,key:string):Promise<StoredArchivedCleanupOutcome>{
    let actor:Principal,intent:z.output<typeof intentSchema>,jobId:string;try{const parsed=parseStoragePrincipal(raw);if(parsed.kind!=='user')throw new Error();actor=parsed;intent=intentSchema.parse(JSON.parse(canonicalJson(rawIntent,16384)));key=z.string().uuid().parse(key).toLowerCase();const h=createHash('sha256').update(canonicalJson(['archived-cleanup-v1',actor.userId,key])).digest('hex');jobId=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}catch{return Promise.resolve(rejected('INVALID_ARGUMENT'));}
    return this.admit(jobId,canonicalJson([this.options.generation,actor,intent]),async()=>{
      const result=await this.perform(jobId,actor,intent);if(result.state!=='committed')return result;
      try{await this.job(jobId,actor);}catch(error){if(error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND'].includes(error.code))return accessDenied(error.code);return result;}
      try{await this.options.changed(intent.projectId);}catch{}
      try{await this.job(jobId,actor);}catch(error){if(error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND'].includes(error.code))return accessDenied(error.code);return result;}
      if(result.cleanupPending||this.closed)return result;
      try{return{...result,usage:(await this.reads.get(actor,intent.projectId)).usage};}catch(error){return error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND'].includes(error.code)?accessDenied(error.code):result;}
    });
  }
  recover(rawJobId:string):Promise<StoredArchivedCleanupOutcome>{
    let jobId:string;try{jobId=z.string().uuid().parse(rawJobId).toLowerCase();}catch{return Promise.resolve(rejected('INVALID_ARGUMENT'));}
    return this.admit(jobId,canonicalJson([this.options.generation,'recovery']),async()=>{
      let job=await this.job(jobId);if(!job)return rejected('NOT_FOUND');if(job.filesFinished)return job.phase==='committed'?committed(job):rejected('CONFLICT');
      if(!job.filesStarted){if(job.phase!=='rejected'){await this.command(jobId,'reject',maintenance,{name:'uploadCleanup.reject',input:{jobId}});job=(await this.job(jobId))??job;}if(job.phase==='rejected'&&!job.filesStarted)return this.settle(job,new AbortController().signal);}
      try{return await this.lock(job,maintenance,async signal=>{if(job!.phase!=='committed'&&job!.phase!=='rejected'){await this.command(jobId,'reject',maintenance,{name:'uploadCleanup.reject',input:{jobId}});job=await this.job(jobId);if(!job)return unknown();}return job?this.settle(job,signal):unknown();});}catch{return job.phase==='committed'?committed(job):job.phase==='rejected'?rejected('CONFLICT',true):unknown();}
    });
  }
  private admit(jobId:string,identity:string,work:()=>Promise<StoredArchivedCleanupOutcome>){
    if(this.closed)return Promise.resolve(rejected('NOT_SUBMITTED'));if(this.owned.size>=16)return Promise.resolve(rejected('OVERLOADED'));
    const key=canonicalJson([this.options.storeId,jobId]),existing=pending.get(key);if(existing)return existing.identity===identity?existing.result:Promise.resolve(unknown());if(pending.size>=16)return Promise.resolve(rejected('OVERLOADED'));
    const result=Promise.resolve().then(work).catch(error=>error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND','NOT_SUBMITTED','OVERLOADED','CONFLICT'].includes(error.code)?rejected(error.code):unknown()),item={identity,result};pending.set(key,item);this.owned.add(result);
    void result.finally(()=>{if(pending.get(key)===item)pending.delete(key);this.owned.delete(result);}).catch(()=>undefined);return result;
  }
  private async job(jobId:string,principal:Principal|typeof maintenance=maintenance){if(this.closed)throw new StorageContractError('NOT_SUBMITTED');await this.options.assertExclusiveWriter();if(this.closed)throw new StorageContractError('NOT_SUBMITTED');const result=await this.options.port.readUploadCleanupJob({principal,jobId});if(this.closed)throw new StorageContractError('NOT_SUBMITTED');return result;}
  private async command(jobId:string,suffix:string,principal:Principal|typeof maintenance,command:CoreCommand){
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');await this.options.assertExclusiveWriter();if(this.closed)throw new StorageContractError('NOT_SUBMITTED');return executeStoredCommand(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),operationId:`upload-cleanup:${jobId}:${principal.kind}:${suffix}`,principal,command});
  }
  private async rejectJob(jobId:string,actor?:Principal){
    if(actor){const result=await this.command(jobId,'reject',actor,{name:'uploadCleanup.reject',input:{jobId}}),current=await this.job(jobId);if(!current||current.phase==='committed'||current.phase==='rejected'||result.state==='unknown')return current;}
    await this.command(jobId,'reject',maintenance,{name:'uploadCleanup.reject',input:{jobId}});return this.job(jobId);
  }
  private async lock(job:UploadCleanupJob,principal:Principal|typeof maintenance,work:(signal:AbortSignal)=>Promise<StoredArchivedCleanupOutcome>){
    if(!job.sourceCurrent||job.active)throw new StorageContractError('CONFLICT');const scope:UploadReadScope={projectId:job.projectId,projectPath:job.request.projectPath,ownerUserId:job.ownerUserId,viewerUserId:principal.kind==='user'?principal.userId:job.actorUserId,viewerRole:job.request.uploaderUserId===null?'admin':'member',active:false,revision:job.jobId};
    return this.options.files.withMutation(scope,async()=>{const current=await this.job(job.jobId,principal);if(!current||!current.sourceCurrent||current.active||current.filesFinished||canonicalJson(current.request,16384)!==canonicalJson(job.request,16384))throw new StorageContractError('CONFLICT');},work);
  }
  private async perform(jobId:string,actor:Principal,intent:z.output<typeof intentSchema>):Promise<StoredArchivedCleanupOutcome>{
    let job=await this.job(jobId,actor);const matches=(value:UploadCleanupJob)=>value.projectId===intent.projectId&&canonicalJson(value.request.attachmentIds,16384)===canonicalJson(intent.attachmentIds,16384);
    if(job&&!matches(job))return rejected('CONFLICT');if(job?.filesFinished)return job.phase==='committed'?committed(job):rejected('CONFLICT');
    const run=async(signal:AbortSignal,expected:{projectPath:string;ownerUserId:string})=>{
      let commitTried=false,submitted=!!job;try{
        if(!job){submitted=true;const result=await this.command(jobId,'register',actor,{name:'uploadCleanup.prepare',input:{jobId,...intent}});job=await this.job(jobId);if(!job)return result.state==='rejected'?rejected(result.code):unknown();}
        if(!matches(job)||job.request.projectPath!==expected.projectPath||job.ownerUserId!==expected.ownerUserId)throw new StorageContractError('CONFLICT');
        if(job.phase==='committed'||job.phase==='rejected')return this.settle(job,signal);
        if(job.phase==='reserved'){const result=await this.command(jobId,'start',actor,{name:'uploadCleanup.startFiles',input:{jobId}});job=await this.job(jobId);if(!job)return unknown();if(job.phase==='reserved'){if(result.state==='rejected')throw new StorageContractError(result.code);return unknown();}}
        const prepared=await this.files(job,'prepare',actor,signal);if(prepared.state!=='prepared')return unknown();
        if(!job.intentDigest){await this.command(jobId,`bind:${prepared.intentDigest}`,actor,{name:'uploadCleanup.bindProof',input:{jobId,intentDigest:prepared.intentDigest,deletedCount:prepared.deletedCount}});job=await this.job(jobId);if(!job)return unknown();}
        if(job.intentDigest!==prepared.intentDigest||job.deletedCount!==prepared.deletedCount||job.phase!=='prepared')return unknown();
        commitTried=true;const result=await this.command(jobId,'commit',actor,{name:'uploadCleanup.commit',input:{jobId,intentDigest:prepared.intentDigest}});if(result.state==='committed')job={...job,phase:'committed'};
        const current=await this.job(jobId);if(current)job=current;if(job.phase==='committed'||job.phase==='rejected')return this.settle(job,signal);
        if(result.state==='rejected'){const rejectedJob=await this.rejectJob(jobId,actor);if(!rejectedJob)return unknown();const settled=await this.settle(rejectedJob,signal);return settled.state==='rejected'?{...settled,code:result.code}:settled;}return unknown();
      }catch(error){
        if(job?.phase==='committed')return committed(job);
        if(job&&!commitTried&&!this.closed){try{const current=await this.rejectJob(jobId,actor);if(current){const settled=await this.settle(current,signal);return settled.state==='rejected'&&error instanceof StorageContractError?{...settled,code:error.code}:settled;}}catch{}}
        return job||submitted?unknown():error instanceof StorageContractError?rejected(error.code):unknown();
      }
    };
    if(job){try{return await this.lock(job,actor,signal=>run(signal,{projectPath:job!.request.projectPath,ownerUserId:job!.ownerUserId}));}catch(error){if(error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND'].includes(error.code))return job.phase==='committed'?accessDenied(error.code):rejected(error.code);return job.phase==='committed'?committed(job):job.phase==='rejected'?rejected('CONFLICT',true):unknown();}}
    const scope=await this.options.port.readUploadScope({principal:actor,projectId:intent.projectId});if(scope.active)return rejected('CONFLICT');
    try{return await this.options.files.withMutation(scope,async()=>{if(this.closed)throw new StorageContractError('NOT_SUBMITTED');await this.options.assertExclusiveWriter();const current=await this.options.port.readUploadScope({principal:actor,projectId:intent.projectId});if(current.projectPath!==scope.projectPath||current.ownerUserId!==scope.ownerUserId||current.active)throw new StorageContractError('CONFLICT');},signal=>run(signal,scope));}
    catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')return rejected('NOT_FOUND');throw error;}
  }
  private async files(job:UploadCleanupJob,action:'prepare'|'reconcile'|'rollback',principal:Principal|typeof maintenance,signal:AbortSignal):Promise<ArchivedCleanupResult>{
    const source=new ArchivedUploadCleanup({assertWriter:async(request,control)=>{
      const current=await this.job(job.jobId,principal);if(!current||!current.sourceCurrent||current.active||current.filesFinished||canonicalJson(current.request,16384)!==canonicalJson(request,16384))throw new StorageContractError('CONFLICT');
      if(control.mode==='write'){
        if(current.intentDigest&&current.intentDigest!==control.intentDigest||!control.intentDigest&&(current.intentDigest!==null||(action==='prepare'?current.phase!=='isolating':current.phase!=='rejected')))throw new StorageContractError('CONFLICT');
        if(action==='prepare'?!['isolating','prepared'].includes(current.phase):!['committed','rejected'].includes(current.phase))throw new StorageContractError('CONFLICT');
      }
    },resolveDecision:async(request,intentDigest)=>{const current=await this.job(job.jobId);if(!current||canonicalJson(current.request,16384)!==canonicalJson(request,16384)||current.intentDigest&&current.intentDigest!==intentDigest)return'unknown';return current.phase==='committed'?'committed':current.phase==='rejected'?'rejected':'unknown';}});
    return source.run(job.request,action,signal);
  }
  private async settle(job:UploadCleanupJob,signal:AbortSignal):Promise<StoredArchivedCleanupOutcome>{
    try{
      if(job.phase!=='committed'&&job.phase!=='rejected')return unknown();if(job.filesFinished)return job.phase==='committed'?committed(job):rejected('CONFLICT');
      let proof=job.intentDigest;
      if(job.phase==='rejected'&&!job.filesStarted){await this.command(job.jobId,'finish-unmoved',maintenance,{name:'uploadCleanup.finishFiles',input:{jobId:job.jobId,intentDigest:null,disposition:'unmoved'}});}
      else{
        const result=await this.files(job,job.phase==='committed'?'reconcile':'rollback',maintenance,signal);if(result.state!==(job.phase==='committed'?'committed':'rolled-back'))return job.phase==='committed'?committed(job):rejected('CONFLICT',true);proof=result.intentDigest;
        if(!job.intentDigest){await this.command(job.jobId,`rollback-proof:${proof}`,maintenance,{name:'uploadCleanup.bindProof',input:{jobId:job.jobId,intentDigest:proof,deletedCount:result.deletedCount}});job=(await this.job(job.jobId))??job;if(job.intentDigest!==proof)return rejected('CONFLICT',true);}
        await this.command(job.jobId,`finish:${proof}`,maintenance,{name:'uploadCleanup.finishFiles',input:{jobId:job.jobId,intentDigest:proof,disposition:job.phase==='committed'?'removed':'restored'}});
      }
      job=(await this.job(job.jobId))??job;return job.phase==='committed'?committed(job):rejected('CONFLICT',!job.filesFinished);
    }catch{return job.phase==='committed'?committed(job):rejected('CONFLICT',true);}
  }
  async close(){this.closed=true;await Promise.allSettled([...this.owned]);await this.reads.close();}
}
