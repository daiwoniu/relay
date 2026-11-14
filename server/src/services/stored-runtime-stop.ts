import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CoreStoragePort,StoragePrincipal,StorageRejectionCode } from '../storage/contracts.js';
import { canonicalJson,StorageContractError,parseStoragePrincipal } from '../storage/command-boundary.js';
import type { SessionRuntime } from '../engine/runtime.js';
import type { StoredRuntimeEvents } from '../engine/stored-runtime-events.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';

type Actor=Extract<StoragePrincipal,{kind:'user'}>;
type TerminalContext=Parameters<Parameters<RuntimeStorage['processLocal']>[1]>[0];
export interface StoredStopBinding {runtime:SessionRuntime;version:number;events:StoredRuntimeEvents}
type Result={state:'requested';confirmed:boolean}|{state:'unknown'}|{state:'rejected';code:StorageRejectionCode};
type StopStage='owner'|'intent'|'binding'|'dispatch'|'provider'|'terminal';
export interface StopDiagnostic {
  trace:string;stage:StopStage;event:'begin'|'committed'|'confirmed'|'failed'|'rejected'|'already_requested'|'superseded';elapsedMs:number;code?:string;
}
interface Options {
  storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>;
  /** Returns the same binding object for the lifetime of this exact runtime version. */
  getBinding:(sessionId:string)=>StoredStopBinding|undefined;
  onStopped:(binding:StoredStopBinding,context:TerminalContext)=>Promise<void>;
  onRequested?:(sessionId:string)=>Promise<void>;
  onFailure?:(code:'STOP_UNCONFIRMED')=>void;
  onDiagnostic?:(event:StopDiagnostic)=>void;
}
const inputSchema=z.object({sessionId:z.string().min(1).max(256),expectedAttemptId:z.string().min(1).max(256)}).strict();

/** Candidate explicit stop. Socket closure is never interpreted as a stop request. */
export class StoredRuntimeStop {
  private closed=false;
  private readonly pending=new Map<string,{digest:string;run:Promise<Result>}>();
  constructor(private readonly port:CoreStoragePort,private readonly options:Options){
    if(!options.storeId||!Number.isSafeInteger(options.generation)||options.generation<0)throw new StorageContractError('INVALID_ARGUMENT');
  }
  private current(){if(this.closed)throw new StorageContractError('STORAGE_UNAVAILABLE');}
  private report(){try{this.options.onFailure?.('STOP_UNCONFIRMED');}catch{/* Stable diagnostic only. */}}
  request(actor:Actor,input:{sessionId:string;expectedAttemptId:string},operationId:string):Promise<Result>{
    if(this.closed)return Promise.resolve({state:'rejected',code:'NOT_SUBMITTED'});
    const parsed=inputSchema.safeParse(input);
    if(!parsed.success||typeof operationId!=='string'||!operationId||operationId.length>256)return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});
    const identity=parseStoragePrincipal(actor);if(identity.kind!=='user')return Promise.resolve({state:'rejected',code:'FORBIDDEN'});
    actor=Object.freeze({...identity});
    const intent=parsed.data,digest=createHash('sha256').update(canonicalJson(intent)).digest('hex');
    const key=canonicalJson([actor,operationId]),existing=this.pending.get(key);
    if(existing)return existing.digest===digest?existing.run:Promise.resolve({state:'rejected',code:'CONFLICT'});
    if(this.pending.size>=16)return Promise.resolve({state:'rejected',code:'OVERLOADED'});
    const run=Promise.resolve().then(()=>this.run(actor,intent,operationId));this.pending.set(key,{digest,run});
    void run.finally(()=>{if(this.pending.get(key)?.run===run)this.pending.delete(key);}).catch(()=>undefined);return run;
  }
  private async run(actor:Actor,input:{sessionId:string;expectedAttemptId:string},operationId:string):Promise<Result>{
    let submitted=false;
    let stage:StopStage='owner';
    const started=Date.now(),trace=createHash('sha256').update(operationId).digest('hex').slice(0,16);
    const diagnostic=(event:StopDiagnostic['event'],code?:string)=>{
      try{this.options.onDiagnostic?.({trace,stage,event,elapsedMs:Date.now()-started,...(code?{code}:{})});}catch{/* Diagnostics cannot change a stop outcome. */}
    };
    try{
      diagnostic('begin');
      this.current();await this.options.assertExclusiveWriter();this.current();submitted=true;
      stage='intent';diagnostic('begin');
      const result=await this.port.execute({protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,
        requestId:randomUUID(),operationId,principal:actor,command:{name:'turn.requestStop',input}});
      if(result.state==='rejected'){diagnostic('rejected',result.code);return{state:'rejected',code:result.code};}
      if(result.state!=='committed'||result.replayed){diagnostic('failed',result.state==='committed'?'REPLAYED':'UNKNOWN');this.report();return{state:'unknown'};}
      diagnostic('committed');
      if(!result.value.requested){diagnostic('already_requested');return{state:'requested',confirmed:false};}
      stage='binding';
      this.current();
      const binding=this.options.getBinding(input.sessionId),runtime=binding?.runtime,connection=runtime?.engineConnection;
      if(!binding||!runtime||!connection||!runtime.isRunning||runtime.attemptId!==input.expectedAttemptId||runtime.leaseToken!==result.value.leaseToken
        ||runtime.engine!==result.value.engineId||!runtime.engineConnectionId||runtime.interruptPromise){diagnostic('failed','RUNTIME_NOT_CURRENT');this.report();return{state:'unknown'};}
      const captured={attemptId:runtime.attemptId,connectionId:runtime.engineConnectionId,leaseToken:runtime.leaseToken,version:binding.version};
      const owned=()=>this.options.getBinding(input.sessionId)===binding&&runtime.attemptId===captured.attemptId
        &&runtime.engineConnection===connection&&runtime.engineConnectionId===captured.connectionId&&runtime.leaseToken===captured.leaseToken
        &&binding.version===captured.version;
      runtime.isStopping=true;
      const physical=Promise.resolve().then(async():Promise<Result>=>{
        try{await this.options.onRequested?.(input.sessionId);}catch{this.report();}
        stage='dispatch';diagnostic('begin');
        this.current();await this.options.assertExclusiveWriter();this.current();
        if(!owned()||!runtime.isRunning)throw new StorageContractError('CONFLICT');
        const allowed=await this.port.checkStopDispatch({principal:actor,operationId,runtime:{kind:'runtime',sessionId:input.sessionId,
          attemptId:captured.attemptId,connectionId:captured.connectionId,runtimeVersion:captured.version}});this.current();
        if(!allowed||!owned()||!runtime.isRunning)throw new StorageContractError('CONFLICT');
        stage='provider';diagnostic('begin');
        await connection.cancel();
        diagnostic('confirmed');
        // A different/new runtime cannot receive this old connection's completion.
        if(!owned()||!runtime.isRunning){diagnostic('superseded');return{state:'requested',confirmed:false};}
        stage='terminal';diagnostic('begin');
        let projected=false;
        await binding.events.storage.processLocal({type:'interrupt_confirmed',userInitiated:true},async(context)=>{
          await this.options.onStopped(binding,{...context,finishTerminal:async message=>{
            const value=await context.finishTerminal(message);projected=value.projection.decision.outcome==='stopped'&&value.projection.savedMessage.stopped;return value;
          },persistTerminal:async(terminal)=>{
            if(terminal.decision.outcome!=='stopped'||terminal.decision.factId!==context.fact.id)throw new StorageContractError('CONFLICT');
            const value=await context.persistTerminal(terminal);projected=value.projection.decision.outcome==='stopped'&&value.projection.savedMessage.stopped;return value;
          }});
        });
        if(!projected)throw new StorageContractError('CONFLICT');
        diagnostic('confirmed');
        return{state:'requested',confirmed:true};
      });
      runtime.interruptPromise=physical.then(()=>undefined);void runtime.interruptPromise.catch(()=>undefined);
      const interrupt=runtime.interruptPromise;
      try{return await physical;}finally{if(runtime.interruptPromise===interrupt)runtime.interruptPromise=null;}
    }catch(error){
      const networkCode=error&&typeof error==='object'&&'code'in error?error.code:null;
      const rpcCode=error&&typeof error==='object'&&'rpcCode'in error?error.rpcCode:null;
      const code=error instanceof StorageContractError?error.code
        :typeof networkCode==='string'&&['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ECONNABORTED','EPIPE'].includes(networkCode)?networkCode
        :typeof rpcCode==='number'&&Number.isSafeInteger(rpcCode)&&Math.abs(rpcCode)<=2147483647?`RPC_${rpcCode}`
        :error instanceof TypeError?'LOCAL_TYPE_ERROR'
        :error instanceof Error&&error.name==='CodexRpcTimeoutError'?'RPC_TIMEOUT'
        :error instanceof Error&&error.name==='CodexRpcError'?'RPC_CONNECTION_UNKNOWN':'UNCLASSIFIED';
      diagnostic('failed',code);
      if(!submitted)return{state:'rejected',code:error instanceof StorageContractError?error.code:'NOT_SUBMITTED'};
      // cancel rejection/timeout may have reached the engine. Preserve stopping/lease and reconcile facts.
      this.report();return{state:'unknown'};
    }
  }
  async close():Promise<void>{this.closed=true;await Promise.allSettled([...this.pending.values()].map(item=>item.run));}
}
