import { randomUUID } from 'node:crypto';
import type { CoreStoragePort, QueueClaim, StorageCommandEnvelope } from '../../storage/contracts.js';
import { operationIdentity, StorageContractError } from '../../storage/command-boundary.js';

const principal={kind:'system',purpose:'scheduler'} as const;
type ClaimRequest=StorageCommandEnvelope & {command:{name:'queue.claim';input:{resourceKey:string;claimToken:string}}};
type Port=Pick<CoreStoragePort,'execute'|'lookup'|'readSchedulerState'|'checkQueueDispatch'>;
export interface StoredDispatchContext {
  signal:AbortSignal;
  /** Complete async preparation first, then invoke the actual engine call through this one-shot capability. */
  dispatch<T>(effect:()=>T,options?:{sourceDigest:string}):Promise<T>;
}
export interface StoredSchedulerOptions {
  storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>;
  start:(claim:QueueClaim,context:StoredDispatchContext)=>Promise<void>;
  /** Must reconcile/persist a real outcome; effectStarted means an engine reply may be unknown. Never requeue. */
  failed:(claim:QueueClaim,error:unknown,context:{effectStarted:boolean})=>Promise<void>;
  onFailure:(resourceKey:string,code:'SCHEDULER_UNCONFIRMED')=>void;
  changed?:(resourceKey:string)=>Promise<void>;
  now?:()=>number;
}
interface Resource {again:boolean;running:boolean;run:Promise<void>;unknown?:ClaimRequest;timer?:ReturnType<typeof setTimeout>;wakeAt?:number}

/** Candidate for the native graph. No legacy repository calls or duplicate probe/capacity writes. */
export class StoredProviderTurnScheduler {
  private readonly resources=new Map<string,Resource>();
  private readonly controller=new AbortController();
  private closed=false;
  private readonly now:()=>number;
  constructor(private readonly port:Port,private readonly options:StoredSchedulerOptions){
    if(!options.storeId||!Number.isSafeInteger(options.generation)||options.generation<0)throw new StorageContractError('INVALID_ARGUMENT');
    this.now=options.now??Date.now;
  }
  private current(){if(this.closed)throw new StorageContractError('STORAGE_UNAVAILABLE');}
  private report(key:string){try{this.options.onFailure(key,'SCHEDULER_UNCONFIRMED');}catch{/* Diagnostics do not own execution. */}}
  drain(key:string):Promise<void>{
    if(this.closed)return Promise.reject(new StorageContractError('STORAGE_UNAVAILABLE'));
    if(typeof key!=='string'||!key||key.length>256)return Promise.reject(new StorageContractError('INVALID_ARGUMENT'));
    let state=this.resources.get(key);
    if(state?.running){state.again=true;return state.run;}
    if(!state){
      if(this.resources.size>=64)return Promise.reject(new StorageContractError('OVERLOADED'));
      state={again:true,running:false,run:Promise.resolve()};this.resources.set(key,state);
    }
    state.running=true;
    const captured=state;
    state.run=Promise.resolve().then(async()=>{
      try{do{captured.again=false;await this.loop(key,captured);}while(captured.again&&!this.closed);}
      catch(error){this.report(key);throw error;}
      finally{if(!this.closed)await this.notify(key);captured.running=false;if(!captured.unknown&&!captured.timer&&this.resources.get(key)===captured)this.resources.delete(key);}
    });
    // Own timer/event boundary rejections even when an emitter discards the return value.
    void state.run.catch(()=>undefined);return state.run;
  }
  private wake(key:string,state:Resource,until:number){
    const delay=Math.max(1,Math.min(2_147_000_000,until-this.now()));
    if(state.timer&&state.wakeAt!==undefined&&state.wakeAt<=until)return;
    if(state.timer)clearTimeout(state.timer);
    state.wakeAt=until;state.timer=setTimeout(()=>{
      state.timer=undefined;state.wakeAt=undefined;
      if(this.closed)return;
      void this.drain(key).catch(()=>undefined);
    },delay);state.timer.unref();
  }
  private async notify(key:string){try{await this.options.changed?.(key);}catch{this.report(key);}}
  private async loop(key:string,state:Resource){
    while(!this.closed){
      await this.options.assertExclusiveWriter();this.current();
      let selected:QueueClaim|null;
      if(state.unknown){
        const request=state.unknown,identity=operationIdentity(request);
        const result=await this.port.lookup({storeId:this.options.storeId,operationId:request.operationId,principal,
          expected:{commandName:'queue.claim',inputDigest:identity.inputDigest}});this.current();
        // Not-found does not prove that a timed-out submission cannot commit later.
        if(result.state!=='committed'||result.commandName!=='queue.claim'){this.report(key);return;}
        selected=result.value;state.unknown=undefined;
      }else{
        const status=await this.port.readSchedulerState({principal,resourceKey:key});this.current();
        if(status.cooldownUntil!==null&&status.cooldownUntil>this.now()){this.wake(key,state,status.cooldownUntil);return;}
        if(status.probeAttemptId)return;
        if(state.timer){clearTimeout(state.timer);state.timer=undefined;state.wakeAt=undefined;}
        await this.options.assertExclusiveWriter();this.current();
        const request:ClaimRequest={protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,
          requestId:randomUUID(),operationId:randomUUID(),principal,command:{name:'queue.claim',input:{resourceKey:key,claimToken:randomUUID()}}};
        // Retain intent before invoking a transport that may throw after submission.
        state.unknown=request;
        const result=await this.port.execute(request);this.current();
        if(result.state==='unknown'){this.report(key);return;}
        state.unknown=undefined;
        if(result.state==='rejected')throw new StorageContractError(result.code);
        selected=result.value;
      }
      if(!selected)return;
      const claim=Object.freeze({...selected});let effectStarted=false,used=false,active=true,dispatched:Promise<unknown>|undefined;
      const context:StoredDispatchContext={signal:this.controller.signal,dispatch:<T>(effect:()=>T,options?:{sourceDigest:string}):Promise<T>=>{
        if(used||!active)return Promise.reject(new StorageContractError('CONFLICT'));used=true;
        const sourceDigest=options?.sourceDigest;
        const work=Promise.resolve().then(async()=>{
          await this.options.assertExclusiveWriter();this.current();
          const allowed=await this.port.checkQueueDispatch({principal,claim,...(sourceDigest===undefined?{}:{sourceDigest})});this.current();
          if(!active||!allowed)throw new StorageContractError('CONFLICT');
          effectStarted=true;return effect();
        });
        dispatched=work;void work.catch(()=>undefined);return work;
      }};
      try{await this.options.start(claim,context);if(!used)throw new StorageContractError('CONFLICT');await dispatched;}
      catch(error){await dispatched?.catch(()=>undefined);await this.options.failed(claim,error,{effectStarted});}
      finally{active=false;}
      await this.notify(key);
    }
  }
  async close():Promise<void>{
    this.closed=true;this.controller.abort();
    for(const state of this.resources.values())if(state.timer)clearTimeout(state.timer);
    await Promise.allSettled([...this.resources.values()].map(state=>state.run));
    // An unresolved claim remains durable in storage; shutdown never converts it to queued.
    this.resources.clear();
  }
}
