import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CoreCommandName,CoreCommandInputs,CoreStoragePort,StorageCommandEnvelope,StoragePrincipal,LocalUsageJob } from '../storage/contracts.js';
import { parseStoragePrincipal,canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { UsageEmailSchema,LocalUsageEventSchema } from '../storage/local-usage-contracts.js';
import type { CodexLocalUsageEvent } from './codex-local-usage.js';
import type { CodexLocalUsageSnapshot } from './codex-local-usage-service.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;
const accountSchema=z.object({email:UsageEmailSchema,accountId:z.string().min(1).max(256).nullable()}).strict();
const maintenance={kind:'system' as const,purpose:'maintenance' as const};
const inflight=new Map<string,{identity:string;result:Promise<CodexLocalUsageSnapshot>}>();
const dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
function day(time:number){const fields=Object.fromEntries(dayFormatter.formatToParts(time).map(({type,value})=>[type,value]));return`${fields.year}-${fields.month}-${fields.day}`;}
/** Source adapters resolve current provider metadata and yield events outside the Worker; no auth material enters this port. */
export class StoredLocalUsage{
  private closed=false;private readonly owned=new Set<Promise<unknown>>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;resolveAccount:()=>Promise<{email:string;accountId:string|null}|null>;
    events:(since:Date,until:Date)=>AsyncIterable<CodexLocalUsageEvent>;now?:()=>number}){this.options=Object.freeze({...options});}
  getSnapshot(principal:Principal):Promise<CodexLocalUsageSnapshot>{
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));const actor=parseStoragePrincipal(principal);if(actor.kind!=='user')return Promise.reject(new StorageContractError('FORBIDDEN'));
    const key=canonicalJson([this.options.storeId,this.options.generation]),identity=canonicalJson(actor);const prior=inflight.get(key);
    if(prior)return prior.identity===identity?prior.result:Promise.reject(new StorageContractError('OVERLOADED'));
    const result=Promise.resolve().then(()=>this.perform(actor));inflight.set(key,{identity,result});this.owned.add(result);
    void result.finally(()=>{if(inflight.get(key)?.result===result)inflight.delete(key);this.owned.delete(result);}).catch(()=>undefined);return result;
  }
  async close(){this.closed=true;await Promise.allSettled([...this.owned]);}
  private command<K extends CoreCommandName>(principal:StoragePrincipal,jobId:string,suffix:string,name:K,input:CoreCommandInputs[K]){
    if(this.closed&&principal.kind==='user')throw new StorageContractError('NOT_SUBMITTED');
    return executeStoredCommand<K>(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),operationId:`local-usage:${jobId}:${suffix}`,principal,command:{name,input}} as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}});
  }
  private async account(){const value=await this.options.resolveAccount();if(!value)throw new StorageContractError('STORAGE_UNAVAILABLE');return accountSchema.parse(value);}
  private async perform(actor:Principal):Promise<CodexLocalUsageSnapshot>{
    const access=await this.options.port.readFrontendAccess({principal:actor,resource:null});if(!access||access.user.role!=='admin'||access.user.mustChangePassword||access.expiresAt<=Date.now())throw new StorageContractError('FORBIDDEN');
    const account=await this.account(),now=this.options.now?.()??Date.now();if(!Number.isSafeInteger(now)||!Number.isFinite(new Date(now).getTime()))throw new StorageContractError('INVALID_ARGUMENT');
    const today=day(now),jobId=randomUUID();let failed=!account.accountId;
    if(account.accountId)try{
      const begin=await this.command(actor,jobId,'begin','usage.beginSync',{jobId,email:account.email,accountId:account.accountId,untilDay:today});if(begin.state!=='committed')throw new Error('SYNC_NOT_CONFIRMED');
      let events:CodexLocalUsageEvent[]=[],index=0;
      const flush=async()=>{if(!events.length)return;const value=events;events=[];
        const result=await this.command(actor,jobId,'page-'+index++,'usage.appendSync',{jobId,events:value});if(result.state!=='committed')throw new Error('SYNC_PAGE_NOT_CONFIRMED');};
      for await(const raw of this.options.events(new Date(begin.value.sinceDay+'T00:00:00+08:00'),new Date(now+1))){
        if(this.closed)throw new StorageContractError('NOT_SUBMITTED');events.push(LocalUsageEventSchema.parse(raw));if(events.length===256)await flush();
      }
      await flush();if(canonicalJson(await this.account(),1024)!==canonicalJson(account,1024))throw new StorageContractError('CONFLICT');
      await this.command(actor,jobId,'commit','usage.commitSync',{jobId});
      if((await this.options.port.readLocalUsageJob({principal:actor,jobId}))?.phase!=='committed')throw new Error('SYNC_COMMIT_NOT_CONFIRMED');
    }catch{
      failed=true;
      try{const job=await this.options.port.readLocalUsageJob({principal:maintenance,jobId});
        if(job?.phase==='committed')failed=false;else if(job?.phase==='staging')await this.command(maintenance,jobId,'reject','usage.rejectSync',{jobId});
      }catch{/* Unknown DB state cannot be converted into a successful sync. */}
    }
    if(canonicalJson(await this.account(),1024)!==canonicalJson(account,1024))throw new StorageContractError('CONFLICT');
    const yearStart=new Date(today+'T00:00:00+08:00');yearStart.setUTCDate(yearStart.getUTCDate()-364);
    const stored=await this.options.port.readLocalUsage({principal:actor,email:account.email,sinceDay:day(yearStart.getTime()),untilDay:today}),byDay=new Map(stored.rows.map(row=>[row.day,row.tokens]));
    if(canonicalJson(await this.account(),1024)!==canonicalJson(account,1024))throw new StorageContractError('CONFLICT');
    const current=await this.options.port.readFrontendAccess({principal:actor,resource:null});if(!current||current.user.role!=='admin'||current.user.mustChangePassword||current.expiresAt<=Date.now())throw new StorageContractError('FORBIDDEN');
    const dailyUsageBuckets=failed&&!stored.hasStoredUsage?[]:Array.from({length:365},(_,i)=>{const startDate=day(yearStart.getTime()+i*86400000);return{startDate,tokens:byDay.get(startDate)??0};});
    return{email:account.email,timeZone:'Asia/Shanghai',dailyUsageBuckets,backfill:stored.backfill,
      sourceMeta:{state:failed?stored.hasStoredUsage?'failed_snapshot':'unavailable':'live',lastSuccessAt:stored.lastSuccessAt,lastAttemptAt:now,error:failed?'本机用量同步失败':null}};
  }
  rejectUnfinished(jobId:string):Promise<LocalUsageJob|null>{
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));if(this.owned.size>=16)return Promise.reject(new StorageContractError('OVERLOADED'));jobId=z.string().uuid().parse(jobId);
    const work=Promise.resolve().then(async()=>{const job=await this.options.port.readLocalUsageJob({principal:maintenance,jobId});
      if(job?.phase==='staging')await this.command(maintenance,jobId,'reject','usage.rejectSync',{jobId});return this.options.port.readLocalUsageJob({principal:maintenance,jobId});});
    this.owned.add(work);void work.finally(()=>this.owned.delete(work)).catch(()=>undefined);return work;
  }
}
