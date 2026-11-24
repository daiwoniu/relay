import { randomUUID } from 'node:crypto';
import type { EngineConnection,EngineConnectionOptions } from '../engine/adapter.js';
import { EngineRegistryError,type EngineRegistry } from '../engine/registry.js';
import type { HostContextDelivery } from '../engine/host-context.js';
import type { SessionRuntime } from '../engine/runtime.js';
import { resolveTurnStartPreferences,createSessionRuntimeState,prepareClaimedSessionRuntime } from '../engine/runtime.js';
import { createStoredHostContext } from './stored-host-context.js';
import { projectStoredRuntimeStream,publishStoredRuntimeEvent,type StoredStreamOptions } from './stored-runtime-stream.js';
import { projectStoredRuntimeMetrics } from './stored-runtime-metrics.js';
import { projectStoredRuntimeNotices } from './stored-runtime-notices.js';
import { projectStoredRuntimeInteractions } from './stored-runtime-interactions.js';
import { projectStoredStandalone } from './stored-standalone-interactions.js';
import { projectStoredAsyncQuestion } from './stored-async-questions.js';
import { toAsyncQuestionItem } from '../codex/async-questions.js';
import { StoredRuntimeEvents } from '../engine/stored-runtime-events.js';
import type { CoreStoragePort,QueueClaim,StoredClaimedTurn,StoredRecoveryTurn } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import { RuntimeEventQueueError } from '../storage/runtime-event-queue.js';
import type { RuntimeFailureDiagnostic } from '../storage/runtime-storage.js';
import type { StoredQueuedTurnPorts } from './stored-queued-turn-dispatch.js';
import { formatFeishuTurnPrompt, isFeishuExecutionResource } from '../integrations/feishu-im/native-session-scope.js';

type EventHandler=Parameters<RuntimeStorage['process']>[1];
type CloseHandler=Parameters<RuntimeStorage['processLocal']>[1];
type StorageOptions=ConstructorParameters<typeof RuntimeStorage>[1];
interface Binding {readonly runtime:SessionRuntime;readonly events:StoredRuntimeEvents;readonly session:StoredClaimedTurn['session'];readonly feishuPrivatePeerDisplayName?:string;readonly attemptId:string;readonly version:number}
interface Physical {
  id:string;engine:SessionRuntime['engine'];path:string;connection:EngineConnection|null;current?:Binding;
  closed:boolean;retired:boolean;version:number;externalId:string|null;turns:Map<string,string>;
  controls:Set<Promise<unknown>>;tainted:boolean;standalonePending:number;
  retirement?:Promise<void>;
  recoveryTried?:boolean;
  terminalObserved?:string;
  recovery?:{resolve:()=>void;reject:(error:Error)=>void};
}
export interface StoredRuntimeConnectionOptions {
  port:CoreStoragePort;storeId:string;generation:number;runtimes:Map<string,SessionRuntime>;registry:Pick<EngineRegistry,'connect'>&Partial<Pick<EngineRegistry,'get'>>;
  /** Model validation/preparation only, with claim identity already populated; no physical engine calls. */
  prepareRuntime?:(claim:QueueClaim,payload:StoredClaimedTurn,signal:AbortSignal)=>Promise<SessionRuntime>;
  prepareInput?:(claim:QueueClaim,payload:StoredClaimedTurn,signal:AbortSignal)=>Promise<string>;
  /** Native-only proxy: resolve current() per callback and reject stale/unconfirmed marker writes. */
  hostContext?:(sessionId:string,current:()=>Binding|null)=>HostContextDelivery;
  stream?:StoredStreamOptions;
  onRuntimeChanged?:(runtime:SessionRuntime)=>Promise<void>;
  onEvent:(runtime:SessionRuntime,...args:Parameters<EventHandler>)=>ReturnType<EventHandler>;
  onClosed:(runtime:SessionRuntime,...args:Parameters<CloseHandler>)=>ReturnType<CloseHandler>;
  onRecoveryStopped?:(runtime:SessionRuntime,...args:Parameters<CloseHandler>)=>ReturnType<CloseHandler>;
  onFailure:(runtime:SessionRuntime,code:'RUNTIME_STORAGE_UNCONFIRMED',detail?:RuntimeFailureDiagnostic)=>void;
  beforeTerminal?:(runtime:SessionRuntime,...args:Parameters<NonNullable<StorageOptions['beforeTerminal']>>)=>void|Promise<void>;
  onTerminalCommitted?:(runtime:SessionRuntime,...args:Parameters<NonNullable<StorageOptions['onTerminalCommitted']>>)=>void|Promise<void>;
}

/** Actual Native dispatcher preparation. One physical connection survives confirmed logical turns. */
export class StoredRuntimeConnections implements StoredQueuedTurnPorts {
  private suspended=false;
  private readonly prepareRuntime: NonNullable<StoredRuntimeConnectionOptions['prepareRuntime']>;
  private readonly records=new Map<string,Physical>();
  private readonly recoveries=new Set<Promise<void>>();
  private readonly preparing=new Set<string>();
  constructor(private readonly options:StoredRuntimeConnectionOptions){this.options=Object.freeze({...options});this.prepareRuntime=options.prepareRuntime??(async()=>{throw new StorageContractError('NOT_SUBMITTED');});}
  private owned(binding:Binding){return this.options.runtimes.get(binding.runtime.sessionId)===binding.runtime;}
  private assert(condition:unknown):asserts condition{if(!condition)throw new StorageContractError('CONFLICT');}
  private async drainFinished(binding:Binding,retire=false){
    this.assert(binding.events.storage.isTerminalCommitted());
    try{if(retire)await binding.events.close();else await binding.events.storage.drain();}
    catch(error){
      // Publication/cleanup can fail after commit; this cannot revive or permanently pin the ended attempt.
      if(!(error instanceof RuntimeEventQueueError)||error.code!=='FAILED'
        ||!binding.events.storage.isTerminalCommitted()||binding.events.storage.health().pending!==0)throw error;
    }
  }
  private async sessionReady(record:Physical,id:string){
    const binding=record.current;this.assert(binding&&!record.closed&&!record.retired&&this.owned(binding));
    await binding.events.sessionReady(record.externalId)(id);
    this.assert(record.current===binding&&!record.closed&&!record.retired&&this.owned(binding));record.externalId=id;
  }
  private connect(record:Physical,sessionId:string,preferences:NonNullable<EngineConnectionOptions['initialTurnOptions']>['preferences']){
    const current=()=>!record.retired&&!record.closed&&record.current&&this.owned(record.current)?record.current:null;
    const hostContext=this.options.hostContext?.(sessionId,current)??createStoredHostContext(current,(binding,event)=>{
      const turnId=event.meta.externalTurnId||('turnId' in event.payload?event.payload.turnId:undefined);
      return !turnId||record.turns.get(turnId)===binding.attemptId;
    });
    // Long-lived SDK callbacks must not capture a dispatcher's full user-message snapshot.
    return this.options.registry.connect(record.engine,{sessionId,cwd:record.path,externalSessionId:record.externalId,
      initialTurnOptions:{preferences},hostContext,
      ...(record.current?.runtime.isRecovering?{recoverTurnId:record.current.runtime.currentTurnId,recoverStartedAt:record.current.runtime.turnStartTime}:{}),
      onSessionReady:id=>this.sessionReady(record,id),onEvent:event=>this.route(record,event),onClosed:()=>this.closed(record)});
  }
  private bind(runtime:SessionRuntime,record:Physical,{session,feishuPrivatePeerDisplayName}: Pick<StoredClaimedTurn,'session'|'feishuPrivatePeerDisplayName'>,attemptId:string):Binding{
    const version=++record.version;
    if(record.current&&record.current.attemptId!==attemptId)record.recoveryTried=false;
    record.terminalObserved=undefined;
    const events=new StoredRuntimeEvents(runtime,this.options.port,{storeId:this.options.storeId,generation:this.options.generation,runtimeVersion:version,
      isOwned:candidate=>this.options.runtimes.get(candidate.sessionId)===candidate,
      onFailure:(code,detail)=>{
        record.recovery?.reject(new StorageContractError('STORAGE_UNAVAILABLE'));this.options.onFailure(runtime,code,detail);
        if(record.current?.runtime===runtime&&record.terminalObserved===runtime.attemptId)this.recoverFailed(record,record.current);
      },beforeTerminal:guard=>this.options.beforeTerminal?.(runtime,guard),
      onTerminalCommitted:async(effect,guard)=>{try{await this.options.onTerminalCommitted?.(runtime,effect,guard);}finally{
        if(this.options.runtimes.get(runtime.sessionId)===runtime){
          runtime.isRunning=false;runtime.isStopping=false;runtime.isRecovering=false;
          if(runtime.pendingInteractions.size===0)Object.assign(runtime,{turnItems:[],processTimeline:[],currentContent:'',commentaryContent:'',finalAnswerContent:'',
            lastFinalAnswerItemId:null,turnModelSnapshot:null,latestTokenUsage:null,tokenUsage:null});
        }
      }},
    });
    return Object.freeze({runtime,events,session,feishuPrivatePeerDisplayName,attemptId,version});
  }
  private facade(record:Physical,binding:Binding):EngineConnection{
    const current=()=>!record.closed&&!record.retired&&!record.retirement&&record.current===binding&&this.owned(binding)&&!binding.events.storage.isTerminalCommitted();
    const control=<T>(effect:()=>T,standalone=false):Promise<Awaited<T>>=>{
      this.assert(current()||standalone&&!record.closed&&!record.retired&&!record.retirement&&record.current===binding&&this.owned(binding)&&binding.events.storage.isTerminalCommitted());if(record.controls.size>=16)throw new StorageContractError('OVERLOADED');
      let result:T;try{result=effect();}catch(error){record.tainted=true;throw error;}
      const pending=Promise.resolve(result).catch(error=>{record.tainted=true;throw error;});
      record.controls.add(pending);void pending.finally(()=>record.controls.delete(pending)).catch(()=>{});return pending;
    };
    return{
      send:(content,options)=>{this.assert(current());record.connection!.send(content,options);},
      cancel:()=>control(()=>record.connection!.cancel()),
      respondToInteraction:(id,result)=>control(()=>record.connection!.respondToInteraction(id,result),[...binding.runtime.pendingInteractions.values()].some(p=>p.standalone&&p.request.requestId===id)),
      ...(record.connection?.steer?{steer:(input:Parameters<NonNullable<EngineConnection['steer']>>[0])=>control(()=>record.connection!.steer!(input))}:{}),
      close:()=>{
        if(record.retired||record.current!==binding||!this.owned(binding))return;
        this.assert(binding.events.storage.isTerminalCommitted());
        void this.closeSession(binding.runtime.sessionId).catch(error=>{
          if(error instanceof StorageContractError&&error.code==='CONFLICT')return;
          try{this.options.onFailure(binding.runtime,'RUNTIME_STORAGE_UNCONFIRMED');}catch{/* Diagnostic only. */}
        });
      },
    };
  }
  private route(record:Physical,event:Parameters<EventHandler>[0]){
    if(this.suspended||record.retired)return;
    if(record.externalId&&event.meta.externalSessionId&&event.meta.externalSessionId!==record.externalId)return;
    const idle=record.current;
    const asyncQuestion=(event.payload.type==='item_start'||event.payload.type==='item_complete')&&!!toAsyncQuestionItem(event.payload.item);
    if(idle&&idle.events.storage.isTerminalCommitted()&&this.preparing.has(idle.runtime.sessionId)&&(['server_request','server_request_resolved'].includes(event.payload.type)||asyncQuestion)){
      record.tainted=true;this.options.onFailure(idle.runtime,'RUNTIME_STORAGE_UNCONFIRMED');return;
    }
    if(idle&&this.owned(idle)&&idle.events.storage.isTerminalCommitted()){
      if(!['server_request','server_request_resolved'].includes(event.payload.type)&&!asyncQuestion)return;
      // Latch synchronously: preparation cannot retire this fence while the request is being stored.
      if(this.preparing.has(idle.runtime.sessionId)){record.tainted=true;this.options.onFailure(idle.runtime,'RUNTIME_STORAGE_UNCONFIRMED');return;}
      record.standalonePending++;
      const captured=structuredClone(event);
      void idle.events.storage.standaloneEvent(async context=>{
        if(!await projectStoredAsyncQuestion(idle.runtime,captured,context,this.options.stream))
          await projectStoredStandalone(idle.runtime,idle.version,captured,context,this.options.registry.get?.(idle.runtime.engine).interactions,this.options.stream);
        context.guard.assertCurrent();await this.options.onRuntimeChanged?.(idle.runtime);
      }).catch(()=>{record.tainted=true;this.options.onFailure(idle.runtime,'RUNTIME_STORAGE_UNCONFIRMED');}).finally(()=>record.standalonePending--);
      return;
    }
    const turnId=event.meta.externalTurnId||('turnId' in event.payload?event.payload.turnId:undefined);
    let binding=turnId?record.turns.get(turnId)===record.current?.attemptId?record.current:undefined:record.current;
    if(!binding&&event.payload.type==='turn_start'&&!record.turns.has(event.payload.turnId)&&record.current&&!record.current.events.storage.isTerminalCommitted()){
      binding=record.current;record.turns.set(event.payload.turnId,binding.attemptId);
      if(record.turns.size>128)record.turns.delete(record.turns.keys().next().value!);
    }
    if(!binding&&event.payload.type==='recovery_snapshot'&&record.current?.runtime.isRecovering&&!record.current.runtime.currentTurnId){
      binding=record.current;record.turns.set(event.payload.turnId,binding.attemptId);
    }
    if(!binding&&turnId&&event.payload.type==='error'&&!record.turns.has(turnId)&&record.current
      &&!record.current.events.storage.isTerminalCommitted()&&![...record.turns.values()].includes(record.current.attemptId)
      &&['realtime','request_response','process_exit'].includes(event.meta.source))binding=record.current;
    // Uncorrelated turn events cannot be attributed to a newly prepared attempt.
    if(!binding||binding!==record.current||!this.owned(binding))return;
    if(['message_complete','turn_complete','error'].includes(event.payload.type)&&['realtime','request_response','process_exit'].includes(event.meta.source))record.terminalObserved=binding.attemptId;
    if(binding.events.storage.health().failed){
      // Terminal transport is only a wake-up. Recovery must read the provider snapshot and durable attempt.
      if(record.terminalObserved===binding.attemptId)this.recoverFailed(record,binding);
      return;
    }
    const selected=binding;
    selected.events.accept(event,async(captured,context)=>{
      const handled=await projectStoredRuntimeMetrics(selected.runtime,captured,context,this.options.stream)
        ||await projectStoredRuntimeNotices(selected.runtime,captured,context,{...this.options.stream,onCompactionCommitted:async()=>{
          try{context.guard.assertCurrent();await this.options.onRuntimeChanged?.(selected.runtime);}catch{/* Counter is committed; synchronization can retry on reconnect. */}
        }})
        ||await projectStoredRuntimeInteractions(selected.runtime,captured,context,this.options.registry.get?.(selected.runtime.engine).interactions,this.options.stream)
        ||await projectStoredAsyncQuestion(selected.runtime,captured,context,this.options.stream)
        ||await projectStoredRuntimeStream(selected.runtime,captured,context.guard,this.options.stream);
      if(!handled)await this.options.onEvent(selected.runtime,captured,context);
        if(['turn_start','server_request','server_request_resolved'].includes(captured.payload.type)
          ||((captured.payload.type==='item_start'||captured.payload.type==='item_complete')&&!!toAsyncQuestionItem(captured.payload.item))){
        try{context.guard.assertCurrent();await this.options.onRuntimeChanged?.(selected.runtime);}catch{/* Lifecycle state is committed; synchronization can retry on reconnect. */}
      }
      if(captured.payload.type==='recovery_snapshot'||selected.events.storage.isTerminalCommitted())record.recovery?.resolve();
    });
  }
  private recoverFailed(record:Physical,binding:Binding){
    if(record.recoveryTried||record.recovery||this.suspended||record.retired
      ||this.options.registry.get?.(record.engine).recovery?.restartMode!=='resume')return;
    record.recoveryTried=true;
    // Leave the failing callback/queue before retiring its fence. Never cancel or resend the input.
    const work=Promise.resolve().then(async()=>{
      await Promise.allSettled([...record.controls]);
      try{await binding.events.storage.drain();}catch(error){
        if(!(error instanceof RuntimeEventQueueError)||error.code!=='FAILED')throw error;
      }
      this.assert(!this.suspended&&this.records.get(binding.runtime.sessionId)===record&&record.current===binding&&this.owned(binding));
      if(binding.events.storage.isTerminalCommitted())return;
      const input=await this.options.port.readRuntimeRecoveryTurn({principal:{kind:'system',purpose:'recovery'},sessionId:binding.runtime.sessionId});
      this.assert(!this.suspended&&this.records.get(binding.runtime.sessionId)===record&&record.current===binding&&this.owned(binding)
        &&input.claim.attemptId===binding.attemptId);
      record.retired=true;
      try{await binding.events.close();}catch(error){if(!(error instanceof RuntimeEventQueueError)||error.code!=='FAILED')throw error;}
      await Promise.resolve(record.connection?.close());
      this.records.delete(binding.runtime.sessionId);this.options.runtimes.delete(binding.runtime.sessionId);
      await this.restore(input,true,record.version);
    });
    record.retirement=work;
    this.recoveries.add(work);
    void work.catch(error=>{try{const health=binding.events.storage.health();this.options.onFailure(binding.runtime,'RUNTIME_STORAGE_UNCONFIRMED',{
      sessionId:binding.runtime.sessionId,attemptId:binding.attemptId,connectionId:record.id,stage:'recovery',
      code:error instanceof StorageContractError?error.code:'UNCLASSIFIED',pending:health.pending,bytes:health.bytes,
    });}catch{/* Diagnostic only. */}})
      .finally(()=>{this.recoveries.delete(work);if(record.retirement===work)record.retirement=undefined;});
  }
  private closed(record:Physical){
    if(this.suspended||record.retired||record.closed)return;record.closed=true;
    const binding=record.current;if(!binding||!this.owned(binding))return;
    if(binding.events.storage.isTerminalCommitted()){
      record.standalonePending++;
      void binding.events.storage.standaloneEvent(async context=>{
        for(const [id,pending] of binding.runtime.pendingInteractions){
          if(!pending.standalone)continue;
          const result=await context.close(id);context.guard.assertCurrent();
          binding.runtime.pendingInteractions.delete(id);
          binding.runtime.turnItems=binding.runtime.turnItems.map(item=>item.id===id?result.item:item);
          await publishStoredRuntimeEvent({type:'item_complete',sessionId:binding.runtime.sessionId,item:result.item},context.guard,this.options.stream??{});
        }
        await this.options.onRuntimeChanged?.(binding.runtime);
      }).catch(()=>{record.tainted=true;this.options.onFailure(binding.runtime,'RUNTIME_STORAGE_UNCONFIRMED');}).finally(()=>record.standalonePending--);
      return;
    }
    record.terminalObserved=binding.attemptId;
    if(binding.events.storage.health().failed){this.recoverFailed(record,binding);return;}
    void this.settleClosed(binding).then(()=>record.recovery?.resolve()).catch(()=>{record.recovery?.reject(new StorageContractError('STORAGE_UNAVAILABLE'));});
  }
  private settleClosed(binding:Binding){
    return binding.events.connectionClosed(async context=>{
      await this.options.onClosed(binding.runtime,context);
      context.guard.assertCurrent();
      if(!binding.events.storage.isTerminalCommitted())throw new StorageContractError('STORAGE_UNAVAILABLE');
    });
  }
  /** Reconnect/read an accepted attempt without send(). Used at startup or after the old fence drains. */
  async restore(input:StoredRecoveryTurn,recoveryTried=false,previousVersion=0){
    this.assert(!this.suspended);
    const {claim,payload}=structuredClone(input);
    this.assert(!this.records.has(claim.sessionId)&&!this.preparing.has(claim.sessionId)&&!this.options.runtimes.has(claim.sessionId));
    if(this.records.size>=128)throw new StorageContractError('OVERLOADED');
    const runtime=createSessionRuntimeState({sessionId:claim.sessionId,projectId:payload.session.projectId,engine:claim.engineId});
    prepareClaimedSessionRuntime(runtime,{projectId:payload.session.projectId,attemptId:claim.attemptId,resourceKey:claim.resourceKey,leaseToken:claim.leaseToken,
      requestedByUserId:claim.requestedByUserId,claimedAt:payload.claimedAt,preferences:{modelId:payload.session.modelId,reasoningEffort:payload.session.reasoningEffort,serviceTier:payload.session.serviceTier}});
    runtime.isRecovering=true;runtime.recoveryPreviousStatus=input.previousStatus as SessionRuntime['recoveryPreviousStatus'];
    runtime.currentTurnId=input.turnId;runtime.turnStartTime=input.startedAt;runtime.tokenUsage=input.tokenUsage;runtime.latestTokenUsage=input.latestTokenUsage;
    runtime.turnItems=structuredClone(input.asyncQuestions);
    const record:Physical={id:randomUUID(),engine:claim.engineId,path:payload.session.projectPath,connection:null,closed:false,retired:false,version:previousVersion,
      externalId:payload.session.engineSessionId,turns:new Map(),controls:new Set(),tainted:false,standalonePending:0,recoveryTried};
    runtime.engineConnectionId=record.id;this.options.runtimes.set(claim.sessionId,runtime);this.records.set(claim.sessionId,record);
    const binding=this.bind(runtime,record,payload,claim.attemptId);record.current=binding;
    if(input.turnId)record.turns.set(input.turnId,claim.attemptId);
    try{
      const prepared=await binding.events.storage.prepareRecovery();this.assert(prepared.state==='handled');
      const adapter=this.options.registry.get?.(claim.engineId);
      if(!adapter)throw new StorageContractError('NOT_SUPPORTED');
      if(adapter?.recovery?.restartMode!=='resume'||!record.externalId){
        const interrupted=adapter?.recovery?.restartMode!=='resume';
        await binding.events.storage.processLocal({type:interrupted?'recovery_interrupted':'recovery_failed',errorCode:interrupted?'RESTART_RECOVERY_INTERRUPTED':'RESTART_RECOVERY_SESSION_MISSING'},context=>this.options.onClosed(runtime,context));
        return binding;
      }
      let timer:ReturnType<typeof setTimeout>|undefined;
      const ready=new Promise<void>((resolve,reject)=>{record.recovery={resolve,reject};timer=setTimeout(()=>reject(new StorageContractError('STORAGE_UNAVAILABLE')),15000);});
      // Own a synchronous connect failure as well as a later timeout.
      void ready.catch(()=>{});
      try{
        record.connection=this.connect(record,claim.sessionId,resolveTurnStartPreferences(runtime));
        runtime.engineConnection=this.facade(record,binding);await ready;
        if(runtime.isStopping&&!binding.events.storage.isTerminalCommitted()){
          const connection=runtime.engineConnection;
          const interrupt=Promise.resolve().then(async()=>{
            await connection.cancel();
            await binding.events.storage.processLocal({type:'interrupt_confirmed',userInitiated:true},context=>(this.options.onRecoveryStopped??this.options.onClosed)(runtime,context));
          });
          runtime.interruptPromise=interrupt;
          try{await interrupt;}finally{if(runtime.interruptPromise===interrupt)runtime.interruptPromise=null;}
        }
        return binding;
      }finally{clearTimeout(timer);record.recovery=undefined;}
    }catch(error){record.tainted=true;try{this.options.onFailure(runtime,'RUNTIME_STORAGE_UNCONFIRMED');}catch{/* Diagnostic only. */}throw error;}
  }
  async prepareInput(claim:QueueClaim,payload:StoredClaimedTurn,signal:AbortSignal){
    if(this.options.prepareInput)return this.options.prepareInput(claim,payload,signal);
    const metadata=JSON.parse(payload.message.metadata??'{}');if(metadata?.attachments?.length)throw new StorageContractError('NOT_SUPPORTED');return payload.message.content;
  }
  async prepare(claim:QueueClaim,input:StoredClaimedTurn,signal:AbortSignal,engineInput?:string){
    this.assert(!this.suspended);
    if(engineInput!==undefined&&(typeof engineInput!=='string'||Buffer.byteLength(engineInput)>1024*1024))throw new StorageContractError('PAYLOAD_TOO_LARGE');
    if(signal.aborted)throw new StorageContractError('NOT_SUBMITTED');
    this.assert(!this.preparing.has(claim.sessionId));this.preparing.add(claim.sessionId);
    const payload=structuredClone(input);Object.freeze(payload.message);Object.freeze(payload.session);Object.freeze(payload);
    let record=this.records.get(claim.sessionId),prior=record?.current,binding:Binding|undefined,installedRuntime:SessionRuntime|undefined,newRecord=false;
    const previousRuntime=this.options.runtimes.get(claim.sessionId);
    try{
      this.assert(!record?.retired&&!record?.retirement&&!record?.standalonePending);
      if(prior){
        await this.drainFinished(prior);await this.drainFinished(prior,true);
        await Promise.allSettled([...record!.controls,...(prior.runtime.interruptPromise?[prior.runtime.interruptPromise]:[])]);
        this.assert(this.records.get(claim.sessionId)===record&&record!.current===prior);
        this.assert(!record!.tainted&&!record!.standalonePending&&prior.runtime.pendingInteractions.size===0&&!prior.runtime.interruptPromise);
      }
      this.assert(!signal.aborted&&(!previousRuntime||previousRuntime===prior?.runtime));
      if(record){
        this.assert(record.engine===claim.engineId&&record.path===payload.session.projectPath&&record.externalId===payload.session.engineSessionId);
        if(record.closed){record.retired=true;this.records.delete(claim.sessionId);record=undefined;}
      }
      if(!record){
        if(this.records.size>=128)throw new StorageContractError('OVERLOADED');
        record={id:randomUUID(),engine:claim.engineId,path:payload.session.projectPath,connection:null,closed:false,retired:false,version:0,externalId:payload.session.engineSessionId,turns:new Map(),controls:new Set(),tainted:false,standalonePending:0};
        this.records.set(claim.sessionId,record);newRecord=true;
      }
      const captured=record,runtime=await this.prepareRuntime(claim,payload,signal);
      this.assert(!signal.aborted&&runtime!==prior?.runtime&&runtime.sessionId===claim.sessionId&&runtime.engine===claim.engineId
        &&runtime.attemptId===claim.attemptId&&runtime.leaseToken===claim.leaseToken&&runtime.resourceKey===claim.resourceKey
        &&runtime.projectId===payload.session.projectId&&!runtime.engineConnection&&!runtime.engineConnectionId
        &&runtime.requestedByUserId===claim.requestedByUserId&&runtime.isRunning&&!runtime.isRecovering
        &&this.options.runtimes.get(claim.sessionId)===previousRuntime&&this.records.get(claim.sessionId)===captured);
      this.options.runtimes.set(claim.sessionId,runtime);installedRuntime=runtime;runtime.engineConnectionId=captured.id;
      binding=this.bind(runtime,captured,payload,claim.attemptId);const events=binding.events;
      if(captured.connection)await events.storage.bindExternalSession(payload.session.engineSessionId,payload.session.engineSessionId!);
      this.assert(!signal.aborted&&!captured.closed&&!captured.retired&&this.owned(binding));
      let invoked=false,released=false;const selected=binding;
      return{
        invoke:async()=>{
          this.assert(!released&&!invoked&&!signal.aborted&&!captured.retired&&!captured.tainted&&!captured.standalonePending&&this.owned(selected));
          invoked=true;captured.current=selected;
          if(captured.closed){await this.settleClosed(selected);return;}
          if(!captured.connection){
            try{captured.connection=this.connect(captured,claim.sessionId,resolveTurnStartPreferences(runtime));}
            catch(error){
              // Registry availability checks precede adapter.connect; other throws may be ambiguous.
              if(!(error instanceof EngineRegistryError)||error.engine!==claim.engineId)throw error;
              await events.route({engineId:claim.engineId,payload:{type:'error',diagnostic:{code:error.code,phase:'availability',retryable:false,userMessage:'引擎不可用，本回合未启动'}},
                meta:{source:'local',sequence:0,observedAt:Date.now()}},(event,context)=>this.options.onEvent(runtime,event,context));
              this.assert(events.storage.isTerminalCommitted());return;
            }
            if(captured.closed){await events.storage.drain();this.assert(events.storage.isTerminalCommitted());return;}
            this.assert(!captured.closed&&!captured.retired&&this.owned(selected));
          }
          runtime.engineConnection=this.facade(captured,selected);
          const content = engineInput ?? payload.message.content;
          const prompt = formatFeishuTurnPrompt(content, { fromFeishu: isFeishuExecutionResource(claim.resourceKey),
            handoff: payload.feishuHandoff, senderDisplayName: payload.feishuSenderDisplayName });
          runtime.engineConnection.send(prompt,{preferences:resolveTurnStartPreferences(runtime)});
        },
        release:async(state:{invoked:boolean})=>{
          if(released)return;released=true;this.preparing.delete(claim.sessionId);
          // Once invoked, a provider result can be unknown. Only an actual terminal can authorize disposal.
          if(state.invoked||invoked)return;
          try{await events.close();}finally{
            if(this.options.runtimes.get(claim.sessionId)===runtime){if(previousRuntime)this.options.runtimes.set(claim.sessionId,previousRuntime);else this.options.runtimes.delete(claim.sessionId);}
            if(newRecord&&!captured.connection&&this.records.get(claim.sessionId)===captured){captured.retired=true;this.records.delete(claim.sessionId);}
          }
        },
      };
    }catch(error){
      this.preparing.delete(claim.sessionId);await binding?.events.close().catch(()=>{});
      if(installedRuntime&&this.options.runtimes.get(claim.sessionId)===installedRuntime){if(previousRuntime)this.options.runtimes.set(claim.sessionId,previousRuntime);else this.options.runtimes.delete(claim.sessionId);}
      if(newRecord&&record&&!record.connection&&this.records.get(claim.sessionId)===record){record.retired=true;this.records.delete(claim.sessionId);}
      throw error;
    }
  }
  getBinding(sessionId:string){const record=this.records.get(sessionId),binding=record?.current;return record&&!record.retired&&binding&&this.owned(binding)?binding:undefined;}
  async closeIdleExternal(sessionId:string,externalId:string,mayClose:()=>Promise<boolean>){
    const record=this.records.get(sessionId),binding=record?.current;
    if(!record||!binding||record.externalId!==externalId||!this.owned(binding)||!binding.events.storage.isTerminalCommitted()||binding.runtime.pendingInteractions.size)return;
    if(await mayClose()&&this.records.get(sessionId)===record&&record.current===binding&&record.externalId===externalId)await this.closeSession(sessionId);
  }
  /** Server shutdown preserves durable attempts/leases. Transport closure is not evidence of a user stop. */
  async suspendAll(){
    this.assert(this.preparing.size===0);this.suspended=true;
    // A recovery can already have replaced the old Physical record while still awaiting its snapshot.
    // Own that work independently of the map and reject only the local wait, without cancelling the turn.
    for(const record of this.records.values())record.recovery?.reject(new StorageContractError('NOT_SUBMITTED'));
    await Promise.allSettled([...this.recoveries,...[...this.records.values()].flatMap(record=>record.retirement?[record.retirement]:[])]);
    for(const [sessionId,record] of this.records){
      const binding=record.current;if(!binding)throw new StorageContractError('CONFLICT');
      await Promise.allSettled([...record.controls]);
      // Let already accepted evidence commit before invalidating its runtime identity.
      try{await binding.events.storage.drain();}catch(error){if(!(error instanceof RuntimeEventQueueError)||error.code!=='FAILED'||binding.events.storage.health().pending!==0)throw error;}
      record.retired=true;
      try{await binding.events.close();}catch(error){if(!(error instanceof RuntimeEventQueueError)||error.code!=='FAILED'||binding.events.storage.health().pending!==0)throw error;}
      await Promise.resolve(record.connection?.close());
      if(this.records.get(sessionId)===record)this.records.delete(sessionId);
      if(this.options.runtimes.get(sessionId)===binding.runtime)this.options.runtimes.delete(sessionId);
    }
  }
  /** Explicit idle retirement only. Active/unknown attempts require actual stop/recovery first. */
  async closeSession(sessionId:string){
    const record=this.records.get(sessionId);if(!record)return;
    if(record.retirement)return record.retirement;
    const binding=record.current;this.assert(binding);
    // A terminal callback cannot await its own event queue; only fully idle bindings may retire.
    this.assert(!this.preparing.has(sessionId)&&binding.events.storage.isTerminalCommitted()&&binding.events.storage.health().pending===0
      &&binding.runtime.pendingInteractions.size===0&&!binding.runtime.interruptPromise&&record.controls.size===0&&record.standalonePending===0);
    const retirement=Promise.resolve().then(async()=>{
      await this.drainFinished(binding);this.assert(this.records.get(sessionId)===record&&!this.preparing.has(sessionId));
      record.retired=true;await this.drainFinished(binding,true);
      await Promise.resolve(record.connection?.close());
      if(this.records.get(sessionId)===record)this.records.delete(sessionId);
      if(this.options.runtimes.get(sessionId)===binding.runtime)this.options.runtimes.delete(sessionId);
    });
    record.retirement=retirement;
    try{await retirement;}finally{if(record.retirement===retirement)record.retirement=undefined;}
  }
}
