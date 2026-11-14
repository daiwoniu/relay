import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import type { CoreCommandName,CoreCommandInputs,CoreStoragePort,StorageCommandEnvelope,StoragePrincipal,ThemeAssetJob } from '../storage/contracts.js';
import { JournaledThemeAssets } from '../theme/journaled-assets.js';
import { validateThemeBackgroundUpload,MAX_THEME_ASSET_BYTES,type ThemeAssetVariant } from '../theme/theme-assets.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;
type Pair={desktop:Uint8Array;mobile:Uint8Array};
export type ThemeAssetOutcome={state:'committed';assetId:string;cleanupPending:boolean}|{state:'rejected';code:ConstructorParameters<typeof StorageContractError>[0]}|{state:'unknown'};
const pending=new Map<string,{identity:string;result:Promise<ThemeAssetOutcome>}>(),maintenance={kind:'system' as const,purpose:'maintenance' as const};
const unknown=():ThemeAssetOutcome=>({state:'unknown'}),hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
function stableId(userId:string,key:string,kind:string){const h=hash(canonicalJson([kind,userId,key]));return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
/** Private candidate service. File decisions always follow durable job state; HTTP timeouts retain accepted ownership. */
export class StoredThemeAssets{
  private closed=false;private readonly owned=new Set<Promise<ThemeAssetOutcome>>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;root:string;assertExclusiveWriter:()=>Promise<void>;timeoutMs?:number}){
    const filesystem=new JournaledThemeAssets(options.root,async()=>{});this.options=Object.freeze({...options,root:filesystem.root});if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>30000))throw new StorageContractError('INVALID_ARGUMENT');
  }
  private actor(principal:Principal){const actor=parseStoragePrincipal(principal);if(actor.kind!=='user'||!z.string().uuid().safeParse(actor.userId).success||actor.userId!==actor.userId.toLowerCase())throw new StorageContractError('INVALID_ARGUMENT');return actor;}
  upload(principal:Principal,input:Pair,key:string):Promise<ThemeAssetOutcome>{
    let actor:Principal,pair:Pair,jobId:string,assetId:string;
    try{
      actor=this.actor(principal);key=z.string().uuid().parse(key).toLowerCase();
      if(!input||!(input.desktop instanceof Uint8Array)||!(input.mobile instanceof Uint8Array)||!input.desktop.length||!input.mobile.length||input.desktop.length>MAX_THEME_ASSET_BYTES||input.mobile.length>MAX_THEME_ASSET_BYTES)throw new Error();
      if(pending.size>=2)throw new StorageContractError('OVERLOADED');
      pair={desktop:Buffer.from(input.desktop),mobile:Buffer.from(input.mobile)};
      if(!validateThemeBackgroundUpload('desktop',pair.desktop).ok||!validateThemeBackgroundUpload('mobile',pair.mobile).ok)throw new Error();
      jobId=stableId(actor.userId,key,'theme-upload');assetId=stableId(actor.userId,key,'theme-asset');
    }catch(e){if(e instanceof StorageContractError&&e.code==='OVERLOADED')return Promise.reject(e);return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    const files={desktop:{digest:hash(pair.desktop),size:pair.desktop.length},mobile:{digest:hash(pair.mobile),size:pair.mobile.length}};
    return this.admit(jobId,canonicalJson([this.options.generation,actor,'upload',assetId,files]),()=>this.perform(actor,jobId,'upload',assetId,pair,files));
  }
  delete(principal:Principal,assetId:string,key:string):Promise<ThemeAssetOutcome>{
    let actor:Principal,jobId:string;
    try{actor=this.actor(principal);assetId=z.string().uuid().parse(assetId).toLowerCase();key=z.string().uuid().parse(key).toLowerCase();jobId=stableId(actor.userId,key,'theme-delete');}
    catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    return this.admit(jobId,canonicalJson([this.options.generation,actor,'delete',assetId]),()=>this.perform(actor,jobId,'delete',assetId));
  }
  recover(jobId:string):Promise<ThemeAssetOutcome>{
    try{jobId=z.string().uuid().parse(jobId).toLowerCase();}catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    return this.admit(jobId,canonicalJson([this.options.generation,'recovery']),async()=>{
      let job=await this.job(jobId,maintenance);if(!job)return unknown();
      if(job.phase==='prepared'){await this.command(jobId,maintenance,{name:'themeAsset.reject',input:{jobId}},'reject');job=await this.job(jobId,maintenance);}
      return job&&job.phase!=='prepared'?this.settle(job):unknown();
    });
  }
  private async admit(jobId:string,identity:string,work:()=>Promise<ThemeAssetOutcome>):Promise<ThemeAssetOutcome>{
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');const key=canonicalJson([this.options.storeId,jobId]);let current=pending.get(key);
    if(current&&current.identity!==identity)return unknown();
    if(!current){if(pending.size>=2)throw new StorageContractError('OVERLOADED');
      const result=Promise.resolve().then(work).catch(e=>e instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND'].includes(e.code)?{state:'rejected' as const,code:e.code}:unknown());
      current={identity,result};pending.set(key,current);this.owned.add(result);const owned=current;
      void result.finally(()=>{if(pending.get(key)===owned)pending.delete(key);this.owned.delete(result);}).catch(()=>undefined);
    }
    let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([current.result,new Promise<ThemeAssetOutcome>(resolve=>{timer=setTimeout(()=>resolve(unknown()),this.options.timeoutMs??10000);timer.unref();})]);}finally{if(timer)clearTimeout(timer);}
  }
  async close(){this.closed=true;await Promise.allSettled([...this.owned]);}
  private async job(jobId:string,principal:StoragePrincipal){await this.options.assertExclusiveWriter();return this.options.port.readThemeAssetJob({principal,jobId});}
  private async command<K extends CoreCommandName>(jobId:string,principal:StoragePrincipal,command:{name:K;input:CoreCommandInputs[K]},suffix:string=randomUUID()){
    await this.options.assertExclusiveWriter();return executeStoredCommand<K>(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,
      requestId:randomUUID(),operationId:`theme-asset:${jobId}:${suffix}`,principal,command} as unknown as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}});
  }
  private files(job:ThemeAssetJob,principal:StoragePrincipal,phase:ThemeAssetJob['phase']){
    return new JournaledThemeAssets(this.options.root,async request=>{
      const current=await this.job(job.jobId,principal);
      if(!current||current.filesFinished||!current.filesStarted||current.phase!==phase||!eq(current.request,request)||phase==='prepared'&&this.closed)throw new StorageContractError('CONFLICT');
    });
  }
  private async perform(actor:Principal,jobId:string,kind:'upload'|'delete',assetId:string,pair?:Pair,files?:{desktop:{digest:string;size:number};mobile:{digest:string;size:number}}):Promise<ThemeAssetOutcome>{
    let job=await this.job(jobId,actor);
    if(!job){
      if(this.closed)return unknown();const command=kind==='upload'?{name:'themeAsset.prepareUpload' as const,input:{jobId,assetId,...files!}}:{name:'themeAsset.prepareDelete' as const,input:{jobId,assetId}};
      const result=await this.command(jobId,actor,command,'prepare');job=await this.job(jobId,actor);
      if(!job)return result.state==='rejected'?{state:'rejected',code:result.code}:unknown();
    }
    if(job.kind!==kind||job.assetId!==assetId||kind==='upload'&&(!eq(job.request.desktop,files!.desktop)||!eq(job.request.mobile,files!.mobile)))return{state:'rejected',code:'CONFLICT'};
    if(job.phase!=='prepared')return this.currentOutcome(actor,job,await this.settle(job));
    try{
      if(this.closed)return this.reject(job);
      if(!job.filesStarted){await this.command(jobId,actor,{name:'themeAsset.startFiles',input:{jobId}},'start');job=await this.job(jobId,actor);if(!job?.filesStarted)return unknown();}
      const proof=await this.files(job,actor,'prepared').prepare(job.request,pair);
      const bound=await this.command(jobId,actor,{name:'themeAsset.bindFiles',input:{jobId,proofDigest:proof.proofDigest}},'bind');
      job=await this.job(jobId,actor);if(!job||job.proofDigest!==proof.proofDigest)return bound.state==='rejected'&&job?this.reject(job):unknown();
      if(this.closed)return this.reject(job);
      await this.files(job,actor,'prepared').apply(job.request,proof.proofDigest);
      if(this.closed)return this.reject(job);
      const result=await this.command(jobId,actor,{name:'themeAsset.commit',input:{jobId,proofDigest:proof.proofDigest}},'commit');
      job=await this.job(jobId,maintenance);if(!job)return unknown();
      if(job.phase==='prepared')return result.state==='rejected'?this.reject(job):unknown();return this.currentOutcome(actor,job,await this.settle(job));
    }catch{
      // Re-read the durable decision before compensating. A lost commit response is never a rollback decision.
      const current=await this.job(jobId,maintenance);if(!current)return unknown();return current.phase==='prepared'?this.reject(current):this.currentOutcome(actor,current,await this.settle(current));
    }
  }
  private async reject(job:ThemeAssetJob){
    await this.command(job.jobId,maintenance,{name:'themeAsset.reject',input:{jobId:job.jobId}},'reject');const current=await this.job(job.jobId,maintenance);
    return current&&current.phase!=='prepared'?this.settle(current):unknown();
  }
  private async currentOutcome(actor:Principal,job:ThemeAssetJob,result:ThemeAssetOutcome){
    if(result.state==='committed'&&!result.cleanupPending&&job.kind==='upload'){
      await this.options.assertExclusiveWriter();await this.options.port.readThemeAsset({principal:actor,assetId:job.assetId});
    }
    return result;
  }
  private async settle(job:ThemeAssetJob):Promise<ThemeAssetOutcome>{
    const committed=job.phase==='committed',assetId=job.assetId;if(job.phase==='prepared')return unknown();
    try{
      if(!job.filesFinished){
        const proof=job.filesStarted?await this.files(job,maintenance,job.phase).settle(job.request,job.phase,job.proofDigest):{proofDigest:hash('unused-theme-files:'+canonicalJson(job.request,4096))};
        if(!job.proofDigest){await this.command(job.jobId,maintenance,{name:'themeAsset.bindFiles',input:{jobId:job.jobId,proofDigest:proof.proofDigest}},'bind-rejected');job=(await this.job(job.jobId,maintenance))!;}
        if(!job||job.proofDigest!==proof.proofDigest)return unknown();
        await this.command(job.jobId,maintenance,{name:'themeAsset.finishFiles',input:{jobId:job.jobId,proofDigest:proof.proofDigest}},'finish');job=(await this.job(job.jobId,maintenance))!;
      }
      if(!job?.filesFinished)return committed?{state:'committed',assetId,cleanupPending:true}:unknown();
      return committed?{state:'committed',assetId:job.assetId,cleanupPending:false}:{state:'rejected',code:'CONFLICT'};
    }catch{return committed?{state:'committed',assetId,cleanupPending:true}:unknown();}
  }
  async read(principal:Principal,assetId:string,variant:ThemeAssetVariant):Promise<Buffer|null>{
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');const actor=this.actor(principal);assetId=z.string().uuid().parse(assetId).toLowerCase();
    await this.options.assertExclusiveWriter();const before=await this.options.port.readThemeAsset({principal:actor,assetId});
    const bytes=await new JournaledThemeAssets(this.options.root,async()=>{await this.options.assertExclusiveWriter();}).read(actor.userId,assetId,variant);
    await this.options.assertExclusiveWriter();const after=await this.options.port.readThemeAsset({principal:actor,assetId});if(!eq(before,after)||this.closed)throw new StorageContractError('CONFLICT');return bytes;
  }
}
const eq=(a:unknown,b:unknown)=>canonicalJson(a,4096)===canonicalJson(b,4096);
