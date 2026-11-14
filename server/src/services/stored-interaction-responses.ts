import { createHash,randomUUID } from 'node:crypto';
import { RespondInteractionCommandSchema,type RespondInteractionCommand } from '../contracts/index.js';
import type { CoreStoragePort,StoragePrincipal,InteractionResponseJob } from '../storage/contracts.js';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import type { SessionRuntime } from '../engine/runtime.js';
import { buildInteractionResponse } from '../ws/frontend-interactions.js';
import type { StoredStopBinding } from './stored-runtime-stop.js';

type Actor=Extract<StoragePrincipal,{kind:'user'}>;
type Pending=SessionRuntime['pendingInteractions'] extends Map<string,infer T>?T:never;
type Outcome={state:'submitted';projectionPending:boolean}|{state:'unknown'}|{state:'rejected';code:string}|{state:'access-denied'};
interface Options {
  storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>;
  getBinding:(sessionId:string)=>StoredStopBinding|undefined;
  getAdapter:(binding:StoredStopBinding)=>EngineInteractionAdapter|undefined;
  submitted:(input:{binding:StoredStopBinding;pending:Pending;command:RespondInteractionCommand;job:InteractionResponseJob;guard:{isCurrent:()=>boolean;assertCurrent:()=>void}})=>Promise<void>;
  prepared?:(sessionId:string,interactionId:string)=>Promise<void>;
  onFailure?:(code:'INTERACTION_RESPONSE_UNCONFIRMED')=>void;
}
const active=new Map<string,{digest:string;run:Promise<Outcome>}>();
const hash=(input:unknown,max=1024*1024)=>createHash('sha256').update(canonicalJson(input,max)).digest('hex');
const maintenance={kind:'system',purpose:'maintenance'} as const;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value;}

/** Candidate for user responses on active turns. Original answers and SDK payloads never enter storage. */
export class StoredInteractionResponses {
  private closed=false;
  private readonly accepted=new Set<Promise<Outcome>>();
  constructor(private readonly port:CoreStoragePort,private readonly options:Options){
    if(!options.storeId||!Number.isSafeInteger(options.generation)||options.generation<0)throw new StorageContractError('INVALID_ARGUMENT');
  }
  private current(){if(this.closed)throw new StorageContractError('STORAGE_UNAVAILABLE');}
  private report(){try{this.options.onFailure?.('INTERACTION_RESPONSE_UNCONFIRMED');}catch{/* No exception text or answer logging. */}}
  respond(actor:Actor,input:RespondInteractionCommand):Promise<Outcome>{
    if(this.closed)return Promise.resolve({state:'rejected',code:'NOT_SUBMITTED'});
    let identity:Actor,command:RespondInteractionCommand,digest:string;
    try{const parsed=parseStoragePrincipal(actor);if(parsed.kind!=='user')throw new StorageContractError('FORBIDDEN');identity=Object.freeze({...parsed});
      command=freeze(JSON.parse(canonicalJson(RespondInteractionCommandSchema.parse(input),256*1024)) as RespondInteractionCommand);
      const {operationId:_operationId,...intent}=command;digest=hash(intent,256*1024);
    }catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    const key=canonicalJson([this.options.storeId,this.options.generation,identity,command.operationId]),previous=active.get(key);
    if(previous)return previous.digest===digest?previous.run:Promise.resolve({state:'rejected',code:'CONFLICT'});
    if(active.size>=16)return Promise.resolve({state:'rejected',code:'OVERLOADED'});
    const run=Promise.resolve().then(()=>this.run(identity,command,digest));active.set(key,{digest,run});this.accepted.add(run);
    void run.finally(()=>{if(active.get(key)?.run===run)active.delete(key);this.accepted.delete(run);}).catch(()=>undefined);return run;
  }
  private jobId(actor:Actor,command:RespondInteractionCommand){return'interaction:'+hash([actor.userId,command.operationId]);}
  private sameIntent(job:InteractionResponseJob,command:RespondInteractionCommand,digest:string){
    return job.sessionId===command.sessionId&&job.interactionId===command.interactionId&&job.responseDigest===digest;
  }
  private async rejectFresh(job:InteractionResponseJob):Promise<Outcome>{
    try{
      await this.options.assertExclusiveWriter();
      const result=await this.port.execute({protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),
        operationId:'interaction-reject:'+hash(job.jobId),principal:maintenance,command:{name:'interaction.rejectUnsubmitted',input:{jobId:job.jobId,
          claimToken:job.claimToken,requestDigest:job.requestDigest,responseDigest:job.responseDigest}}});
      if(result.state==='committed'&&result.value.phase==='rejected')return{state:'rejected',code:'NOT_SUBMITTED'};
      const current=await this.port.readInteractionResponseJob({principal:maintenance,jobId:job.jobId});
      if(current?.phase==='rejected'&&current.claimToken===job.claimToken)return{state:'rejected',code:'NOT_SUBMITTED'};
    }catch{/* No release without a committed negative result. */}
    this.report();return{state:'unknown'};
  }
  private capture(command:RespondInteractionCommand,projection=false){
    const binding=this.options.getBinding(command.sessionId),runtime=binding?.runtime,pending=runtime?.pendingInteractions.get(command.interactionId);
    if(!binding||!runtime||!pending)return null;
    if(!runtime.attemptId||!runtime.leaseToken||pending.standalone&&!binding.events?.storage.isTerminalCommitted())return{unsupported:true} as const;
    const lifecycleCurrent=()=>pending.standalone?!runtime.isRunning&&!runtime.isStopping&&!!binding.events?.storage.isTerminalCommitted():projection||runtime.isRunning&&!runtime.isStopping;
    const connection=runtime.engineConnection,connectionId=runtime.engineConnectionId,attemptId=runtime.attemptId,leaseToken=runtime.leaseToken,version=binding.version,engine=runtime.engine;
    if(!connection||!connectionId||pending.connectionId!==connectionId||!lifecycleCurrent())return null;
    const requestDigest=hash({sessionId:command.sessionId,attemptId,connectionId,version,engine,interactionId:command.interactionId,
      request:pending.request,interaction:pending.interaction,createdAt:pending.createdAt});
    const adapter=this.options.getAdapter(binding);if(!adapter)return{unsupported:true} as const;
    const build=adapter.buildResponse;
    const isCurrent=()=>{
      if(this.options.getBinding(command.sessionId)!==binding||runtime.pendingInteractions.get(command.interactionId)!==pending||runtime.engineConnection!==connection
        ||runtime.engineConnectionId!==connectionId||runtime.attemptId!==attemptId||runtime.leaseToken!==leaseToken||runtime.engine!==engine
        ||binding.version!==version||pending.connectionId!==connectionId||!lifecycleCurrent()||this.options.getAdapter(binding)!==adapter||adapter.buildResponse!==build)return false;
      try{return hash({sessionId:command.sessionId,attemptId,connectionId,version,engine,interactionId:command.interactionId,
        request:pending.request,interaction:pending.interaction,createdAt:pending.createdAt})===requestDigest;}catch{return false;}
    };
    return{binding,pending,connection,connectionId,attemptId,leaseToken,version,engine,requestDigest,adapter,isCurrent};
  }
  private async project(actor:Actor,command:RespondInteractionCommand,job:InteractionResponseJob):Promise<Outcome>{
    let projectionPending=false;
    try{
      const captured=this.capture(command,true);
      if(captured&&!('unsupported'in captured)&&captured.requestDigest===job.requestDigest&&captured.attemptId===job.attemptId
        &&captured.connectionId===job.connectionId&&captured.version===job.runtimeVersion){
        const guard={isCurrent:captured.isCurrent,assertCurrent:()=>{if(!captured.isCurrent())throw new StorageContractError('CONFLICT');}};
        guard.assertCurrent();await this.options.submitted({binding:captured.binding,pending:captured.pending,command,job,guard});
      }
    }catch{projectionPending=true;this.report();}
    try{const current=await this.port.readInteractionResponseJob({principal:actor,jobId:job.jobId});if(!current||current.phase!=='submitted'||!this.sameIntent(current,command,job.responseDigest))return{state:'access-denied'};}
    catch{return{state:'access-denied'};}
    return{state:'submitted',projectionPending};
  }
  private async run(actor:Actor,command:RespondInteractionCommand,digest:string):Promise<Outcome>{
    let prepared=false,fresh:InteractionResponseJob|undefined,effectInvoked=false;
    try{
      this.current();const jobId=this.jobId(actor,command),previous=await this.port.readInteractionResponseJob({principal:actor,jobId});this.current();
      if(previous){
        if(!this.sameIntent(previous,command,digest))return{state:'rejected',code:'CONFLICT'};
        if(previous.phase==='rejected')return{state:'rejected',code:'NOT_SUBMITTED'};
        return previous.phase==='submitted'?this.project(actor,command,previous):{state:'unknown'};
      }
      const captured=this.capture(command);if(!captured)return{state:'rejected',code:'CONFLICT'};
      if('unsupported'in captured)return{state:'rejected',code:'NOT_SUPPORTED'};
      const standardAction=command.action==='accept'?(captured.pending.request.method==='mcpServer/elicitation/request'?'submit':'accept_once'):command.action;
      if(!captured.pending.interaction.availableActions.includes(standardAction))return{state:'rejected',code:'INVALID_ARGUMENT'};
      const response=freeze(JSON.parse(canonicalJson(buildInteractionResponse(captured.adapter,structuredClone(captured.pending.request),command),512*1024)));
      await this.options.assertExclusiveWriter();this.current();if(!captured.isCurrent())return{state:'rejected',code:'CONFLICT'};
      const input={sessionId:command.sessionId,attemptId:captured.attemptId,connectionId:captured.connectionId,runtimeVersion:captured.version,
        interactionId:command.interactionId,requestDigest:captured.requestDigest,responseDigest:digest,claimToken:randomUUID(),...(captured.pending.standalone?{standalone:true as const}:{})};
      prepared=true;
      const result=await this.port.execute({protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),operationId:jobId,
        principal:actor,command:{name:'interaction.prepareResponse',input}});
      if(result.state==='rejected'){
        if(result.code==='CONFLICT'){
          const actual=await this.port.readInteractionResponseJob({principal:actor,jobId});
          if(actual&&this.sameIntent(actual,command,digest))return actual.phase==='submitted'?this.project(actor,command,actual)
            :actual.phase==='rejected'?{state:'rejected',code:'NOT_SUBMITTED'}:{state:'unknown'};
        }
        return{state:'rejected',code:result.code};
      }
      if(result.state!=='committed'||result.replayed){this.report();return{state:'unknown'};}
      fresh=result.value;
      this.current();try{await this.options.prepared?.(command.sessionId,command.interactionId);}catch{this.report();}
      await this.options.assertExclusiveWriter();this.current();
      const allowed=await this.port.checkInteractionDispatch({principal:actor,jobId,claimToken:input.claimToken});this.current();
      if(!allowed||!captured.isCurrent())return this.rejectFresh(fresh);
      // No awaits between the final in-memory identity check and the actual protocol call.
      effectInvoked=true;await captured.connection.respondToInteraction(captured.pending.request.requestId,response);
      // Once transport submission is known, shutdown/revocation cannot turn it into a new permission grant.
      await this.options.assertExclusiveWriter();
      const confirmed=await this.port.execute({protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),
        operationId:'interaction-confirm:'+hash(jobId),principal:maintenance,command:{name:'interaction.confirmResponse',input:{jobId,
          claimToken:input.claimToken,requestDigest:input.requestDigest,responseDigest:digest}}});
      if(confirmed.state==='committed')return this.project(actor,command,confirmed.value);
      const actual=await this.port.readInteractionResponseJob({principal:maintenance,jobId});
      if(actual?.phase==='submitted'&&actual.claimToken===input.claimToken&&actual.responseDigest===digest)return this.project(actor,command,actual);
      this.report();return{state:'unknown'};
    }catch(error){
      if(fresh&&!effectInvoked)return this.rejectFresh(fresh);
      if(prepared){this.report();return{state:'unknown'};}
      return{state:'rejected',code:error instanceof StorageContractError?error.code:'INVALID_ARGUMENT'};
    }
  }
  async close():Promise<void>{this.closed=true;await Promise.allSettled([...this.accepted]);}
}
