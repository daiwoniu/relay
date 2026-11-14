import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CoreStoragePort,CoreCommandInputs,StorageCommandEnvelope,StoragePrincipal,CreditResetOutcome } from '../storage/contracts.js';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
type Actor=Extract<StoragePrincipal,{kind:'user'}>;
const requestSchema=z.object({idempotencyKey:z.string().uuid(),creditId:z.string().min(1).max(256).optional()}).strict();
const outcomeSchema=z.enum(['reset','nothingToReset','noCredit','alreadyRedeemed']);
type Names='creditReset.prepare'|'creditReset.claim'|'creditReset.confirm'|'creditReset.rejectPrepared';

/** A dispatched reset is never sent again, even with a new HTTP key or after service replacement. */
export class StoredCreditReset{
  private closed=false;private readonly pending=new Map<string,{identity:string;work:Promise<CreditResetOutcome>}>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>;
    loadIdentity:()=>Promise<string|null>;consume:(input:{idempotencyKey:string;creditId?:string},context:{expectedIdentityKey:string;mayDispatch:()=>Promise<boolean>})=>Promise<CreditResetOutcome>;
    invalidateOfficial:()=>void}){}
  run(principal:Actor,input:{idempotencyKey:string;creditId?:string}):Promise<CreditResetOutcome>{
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    let actor:Actor,request:z.infer<typeof requestSchema>;
    try{actor=parseStoragePrincipal(principal) as Actor;if(actor.kind!=='user')throw Error();request=requestSchema.parse(input);}
    catch{return Promise.reject(new StorageContractError('INVALID_ARGUMENT'));}
    const identity=canonicalJson([actor,request]),existing=this.pending.get(request.idempotencyKey);
    if(existing)return existing.identity===identity?existing.work:Promise.reject(new StorageContractError('CONFLICT'));
    if(this.pending.size>=8)return Promise.reject(new StorageContractError('OVERLOADED'));
    actor={...actor};request={...request};const work=Promise.resolve().then(()=>this.perform(actor,request));
    this.pending.set(request.idempotencyKey,{identity,work});void work.finally(()=>this.pending.delete(request.idempotencyKey)).catch(()=>undefined);return work;
  }
  private command<K extends Names>(principal:StoragePrincipal,name:K,input:CoreCommandInputs[K]){
    return executeStoredCommand<K>(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),
      operationId:`${name}:${input.jobId}`,principal,command:{name,input}} as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}});
  }
  private async authorize(actor:Actor){
    const access=await this.options.port.readFrontendAccess({principal:actor,resource:null});
    if(!access||access.user.role!=='admin'||access.user.mustChangePassword||access.expiresAt<=Date.now())throw new StorageContractError('FORBIDDEN');
  }
  private async identity(){const value=await this.options.loadIdentity();if(typeof value!=='string'||!value||value.length>512)throw new StorageContractError('STORAGE_UNAVAILABLE');return value;}
  private async perform(actor:Actor,request:z.infer<typeof requestSchema>):Promise<CreditResetOutcome>{
    const{port}=this.options,jobId=request.idempotencyKey;await this.authorize(actor);
    let job=await port.readCreditResetJob({principal:actor,jobId});
    if(job&&job.creditId!==(request.creditId??null))throw new StorageContractError('CONFLICT');
    if(job?.phase==='completed')return outcomeSchema.parse(job.outcome);
    if(job&&job.phase!=='prepared')throw new StorageContractError(job.phase==='dispatched'?'STORAGE_UNAVAILABLE':'CONFLICT');
    const identityKey=await this.identity();if(job&&job.identityKey!==identityKey)throw new StorageContractError('CONFLICT');
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');await this.options.assertExclusiveWriter();
    if(!job){
      const prepared=await this.command(actor,'creditReset.prepare',{jobId,identityKey,creditId:request.creditId??null});
      if(prepared.state!=='committed')throw new StorageContractError(prepared.state==='rejected'?prepared.code:'STORAGE_UNAVAILABLE');job=prepared.value;
      if(job.phase==='completed')return outcomeSchema.parse(job.outcome);if(job.phase!=='prepared')throw new StorageContractError('CONFLICT');
    }
    const claimToken=randomUUID();
    try{
      if(this.closed)throw new StorageContractError('NOT_SUBMITTED');await this.authorize(actor);await this.options.assertExclusiveWriter();
      if(await this.identity()!==identityKey)throw new StorageContractError('CONFLICT');
    }catch(error){await this.command({kind:'system',purpose:'maintenance'},'creditReset.rejectPrepared',{jobId}).catch(()=>undefined);throw error;}
    const claimed=await this.command(actor,'creditReset.claim',{jobId,identityKey,claimToken});
    if(claimed.state!=='committed')throw new StorageContractError(claimed.state==='rejected'?claimed.code:'STORAGE_UNAVAILABLE');
    this.options.invalidateOfficial();let outcome:CreditResetOutcome;
    try{outcome=outcomeSchema.parse(await this.options.consume(request,{expectedIdentityKey:identityKey,mayDispatch:async()=>{
      if(this.closed)return false;await this.options.assertExclusiveWriter();
      const current=await port.readCreditResetJob({principal:actor,jobId});return current?.phase==='dispatched'&&current.claimToken===claimToken&&current.identityKey===identityKey;
    }}));}catch{throw new StorageContractError('STORAGE_UNAVAILABLE');}
    const confirmed=await this.command({kind:'system',purpose:'maintenance'},'creditReset.confirm',{jobId,claimToken,outcome});
    if(confirmed.state!=='committed')throw new StorageContractError('STORAGE_UNAVAILABLE');
    await this.authorize(actor);return outcome;
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending.values()].map(value=>value.work));}
}
