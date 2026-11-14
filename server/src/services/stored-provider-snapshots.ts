import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CodexAccountSnapshotDtoSchema,WorkspaceConsoleResponsibilityDtoSchema,type CodexAccountSnapshotDto } from '../contracts/index.js';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import type { CoreCommandName,CoreCommandInputs,CoreStoragePort,StorageCommandEnvelope,StoragePrincipal,ProviderSnapshotSource,ProviderSnapshotValue } from '../storage/contracts.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;
const identitySchema=z.object({projectKey:z.string().min(1).max(128),userKey:z.string().min(1).max(128)}).strict();
type Identity=z.infer<typeof identitySchema>;
const officialKey=(value:CodexAccountSnapshotDto)=>value.email&&value.authMode!=='unknown'?`${value.authMode}:${value.email.trim().toLowerCase()}`:null;
/** Native-only cache facade. The injected readers are provider/file operations, never legacy DB services. */
export class StoredProviderSnapshots{
  private closed=false;private readonly pending=new Map<string,Promise<unknown>>();
  private officialEpoch=0;private mustRefreshOfficial=false;
  private recentOfficial:{value:CodexAccountSnapshotDto;version:number;until:number;epoch:number}|null=null;
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;
    responsibilityIdentity:()=>Promise<Identity>;loadResponsibility:(expected:Identity)=>Promise<unknown>;
    loadOfficial:()=>Promise<{snapshot:CodexAccountSnapshotDto;limitsOk:boolean;usageOk:boolean}>;now?:()=>number}){this.options=Object.freeze({...options});}
  invalidateOfficial(){this.officialEpoch++;this.mustRefreshOfficial=true;this.recentOfficial=null;}
  private actor(raw:Principal){const value=parseStoragePrincipal(raw);if(value.kind!=='user')throw new StorageContractError('FORBIDDEN');return value;}
  private async authorize(principal:Principal){const value=await this.options.port.readFrontendAccess({principal,resource:null});if(!value||value.user.role!=='admin'||value.user.mustChangePassword||value.expiresAt<=Date.now())throw new StorageContractError('FORBIDDEN');}
  private track<T>(identity:string,work:()=>Promise<T>):Promise<T>{
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));const prior=this.pending.get(identity);if(prior)return prior as Promise<T>;
    if(this.pending.size>=16)return Promise.reject(new StorageContractError('OVERLOADED'));
    const result=Promise.resolve().then(work);this.pending.set(identity,result);void result.finally(()=>{if(this.pending.get(identity)===result)this.pending.delete(identity);}).catch(()=>undefined);return result;
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending.values()]);this.recentOfficial=null;}
  private command<K extends CoreCommandName>(principal:Principal,name:K,input:CoreCommandInputs[K]){
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');return executeStoredCommand<K>(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,
      requestId:randomUUID(),operationId:'provider-cache:'+randomUUID(),principal,command:{name,input}} as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}});
  }
  private read(principal:Principal,source:ProviderSnapshotSource,identityKey:string|null){return this.options.port.readProviderSnapshot({principal,source,identityKey});}
  async hasResponsibilityWorkItem(raw:Principal,id:string):Promise<boolean>{
    const actor=this.actor(raw);await this.authorize(actor);
    const expected=identitySchema.parse(await this.options.responsibilityIdentity());
    const stored=await this.read(actor,'responsibility',`${expected.projectKey}:${expected.userKey}`);
    if(!stored)return false;
    if(canonicalJson(expected)!==canonicalJson(identitySchema.parse(await this.options.responsibilityIdentity())))throw new StorageContractError('CONFLICT');
    const value=WorkspaceConsoleResponsibilityDtoSchema.parse(stored.value);
    return value.items.some(item=>item.workItemId===id)||value.workbenchItems.some(item=>item.workItemId===id||item.mySubtasks.some(child=>child.id===id));
  }
  private async begin(principal:Principal,source:ProviderSnapshotSource,identityKey?:string){
    const result=await this.command(principal,'cache.beginSnapshot',{source,...(identityKey?{identityKey}:{})});if(result.state!=='committed')throw new StorageContractError(result.state==='rejected'?result.code:'STORAGE_UNAVAILABLE');return result.value.version;
  }
  private save(principal:Principal,source:ProviderSnapshotSource,identityKey:string,version:number,value:ProviderSnapshotValue){canonicalJson(value,2*1024*1024);return this.command(principal,'cache.saveSnapshot',{source,identityKey,version,value});}
  private async rememberOfficial(actor:Principal,value:CodexAccountSnapshotDto,version:number,now:number,epoch:number){
    const stored=await this.read(actor,'codex_official',null);if(stored&&stored.version>version){value=CodexAccountSnapshotDtoSchema.parse(stored.value);version=stored.version;}
    if(this.closed||epoch!==this.officialEpoch)throw new StorageContractError('CONFLICT');
    if(this.recentOfficial&&this.recentOfficial.epoch===this.officialEpoch&&this.recentOfficial.version>version)return this.recentOfficial.value;
    this.recentOfficial={value,version,epoch:this.officialEpoch,until:value.sourceMeta?.state==='failed_snapshot'?Number.POSITIVE_INFINITY:now+30*60000};return value;
  }
  responsibility(raw:Principal,force=false){const actor=this.actor(raw);return this.track(canonicalJson([actor,'responsibility',force]),async()=>{
    await this.authorize(actor);const expected=identitySchema.parse(await this.options.responsibilityIdentity()),key=`${expected.projectKey}:${expected.userKey}`;
    const previous=await this.read(actor,'responsibility',key);
    const current=async()=>{if(canonicalJson(identitySchema.parse(await this.options.responsibilityIdentity()),1024)!==canonicalJson(expected,1024))throw new StorageContractError('CONFLICT');await this.authorize(actor);};
    if(previous&&!force){await current();return{...WorkspaceConsoleResponsibilityDtoSchema.parse(previous.value),servedFromCache:true,sourceMeta:{state:'snapshot' as const,lastSuccessAt:previous.savedAt,lastAttemptAt:null,error:null}};}
    const version=await this.begin(actor,'responsibility',key),attempt=this.options.now?.()??Date.now();let value;
    try{value=WorkspaceConsoleResponsibilityDtoSchema.parse(await this.options.loadResponsibility(expected));await current();if(value.sourceUserKey!==expected.userKey)throw new StorageContractError('CONFLICT');}
    catch(error){await current();if(error instanceof StorageContractError&&error.code==='CONFLICT')throw error;
      const stored=await this.read(actor,'responsibility',key);if(!stored)throw new StorageContractError('STORAGE_UNAVAILABLE');
      return{...WorkspaceConsoleResponsibilityDtoSchema.parse(stored.value),servedFromCache:true,stale:true,error:'责任报告来源读取失败',sourceMeta:{state:'failed_snapshot' as const,lastSuccessAt:stored.savedAt,lastAttemptAt:attempt,error:'责任报告来源读取失败'}};
    }
    const success=WorkspaceConsoleResponsibilityDtoSchema.parse({...value,servedFromCache:false,stale:false,error:null,sourceMeta:{state:'live',lastSuccessAt:value.fetchedAt,lastAttemptAt:attempt,error:null}});
    const result=await this.save(actor,'responsibility',key,version,success),stored=await this.read(actor,'responsibility',key);await current();
    if(stored&&(stored.version>=version||result.state==='rejected'&&result.code==='SUPERSEDED'))return WorkspaceConsoleResponsibilityDtoSchema.parse(stored.value);
    throw new StorageContractError(result.state==='rejected'?result.code:'STORAGE_UNAVAILABLE');
  });}
  official(raw:Principal,force=false):Promise<CodexAccountSnapshotDto>{const actor=this.actor(raw);return this.track(canonicalJson([actor,'official',force]),async()=>{
    await this.authorize(actor);const previous=await this.read(actor,'codex_official',null),recent=this.recentOfficial,now=this.options.now?.()??Date.now();
    if(!force&&!this.mustRefreshOfficial){
      if(recent&&recent.epoch===this.officialEpoch&&recent.version>=(previous?.version??0)&&now<recent.until)return recent.value;
      if(previous&&!recent)return{...CodexAccountSnapshotDtoSchema.parse(previous.value),identityVerified:false,sourceMeta:{state:'snapshot',lastSuccessAt:previous.savedAt,lastAttemptAt:null,error:null}};
    }
    const epoch=this.officialEpoch,version=await this.begin(actor,'codex_official');if(epoch!==this.officialEpoch)throw new StorageContractError('CONFLICT');this.mustRefreshOfficial=false;let loaded;
    try{loaded=await this.options.loadOfficial();}catch{loaded={snapshot:{fetchedAt:now,status:'unavailable' as const,authMode:'unknown' as const,email:null,planType:null,rateLimits:[],credits:null,rateLimitResetCredits:null,usage:null,errorMessage:'Codex 账号暂时无法核实'},limitsOk:false,usageOk:false};}
    await this.authorize(actor);if(epoch!==this.officialEpoch)throw new StorageContractError('CONFLICT');
    const value=CodexAccountSnapshotDtoSchema.parse(loaded.snapshot),key=officialKey(value);
    if(value.status==='unavailable'){
      const stored=await this.read(actor,'codex_official',null),prior=recent&&recent.epoch===epoch&&recent.version>=(stored?.version??0)?recent.value:stored?CodexAccountSnapshotDtoSchema.parse(stored.value):null;
      return this.rememberOfficial(actor,prior?{...prior,identityVerified:false,sourceMeta:{state:'failed_snapshot',lastSuccessAt:prior.sourceMeta?prior.sourceMeta.lastSuccessAt:prior.fetchedAt,lastAttemptAt:now,error:'Codex 账号暂时无法核实'}}:{...value,errorMessage:'Codex 账号暂时无法核实',identityVerified:false},version,now,epoch);
    }
    const same=key?await this.read(actor,'codex_official',key):null;
    if(!loaded.limitsOk||!loaded.usageOk){
      const prior=same?CodexAccountSnapshotDtoSchema.parse(same.value):null;
      return this.rememberOfficial(actor,{...value,identityVerified:!!key,fetchedAt:same?.savedAt??value.fetchedAt,rateLimits:loaded.limitsOk?value.rateLimits:prior?.rateLimits??[],credits:loaded.limitsOk?value.credits:prior?.credits??null,
        rateLimitResetCredits:loaded.limitsOk?value.rateLimitResetCredits:prior?.rateLimitResetCredits??null,usage:loaded.usageOk?value.usage:prior?.usage??null,
        sourceMeta:{state:same?'failed_snapshot':'unavailable',lastSuccessAt:same?.savedAt??null,lastAttemptAt:now,error:'Codex 部分数据暂时无法读取'}},version,now,epoch);
    }
    if(!key)return this.rememberOfficial(actor,{...value,identityVerified:false},version,now,epoch);
    const success=CodexAccountSnapshotDtoSchema.parse({...value,identityVerified:true,sourceMeta:{state:'live',lastSuccessAt:value.fetchedAt,lastAttemptAt:now,error:null}}),result=await this.save(actor,'codex_official',key,version,success);
    if(epoch!==this.officialEpoch)throw new StorageContractError('CONFLICT');const stored=await this.read(actor,'codex_official',null);
    if(stored&&(stored.version>=version||result.state==='rejected'&&result.code==='SUPERSEDED')){
      return this.rememberOfficial(actor,CodexAccountSnapshotDtoSchema.parse(stored.value),stored.version,now,epoch);
    }
    throw new StorageContractError(result.state==='rejected'?result.code:'STORAGE_UNAVAILABLE');
  });}
}
