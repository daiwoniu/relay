import { randomUUID,createHash } from 'node:crypto';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { EngineRegistry } from '../engine/registry.js';
import type { SessionRuntime } from '../engine/runtime.js';
import { StoredProviderTurnScheduler } from '../engine/concurrency/stored-scheduler.js';
import { StoredUnstartedTurnFailure } from '../services/stored-unstarted-turn.js';
import { StoredRuntimeStop } from '../services/stored-runtime-stop.js';
import { StoredInteractionResponses } from '../services/stored-interaction-responses.js';
import { createStoredInteractionProjection } from '../services/stored-interaction-projection.js';
import { StoredRuntimeConnections,type StoredRuntimeConnectionOptions } from './stored-runtime-connections.js';
import { StoredQueuedTurnDispatcher } from './stored-queued-turn-dispatch.js';
import { StoredFrontendHub } from './stored-frontend-hub.js';
import { StoredFrontendSync } from './stored-frontend-sync.js';
import { buildRuntimeAssistantSnapshot,type TerminalFileChanges } from './frontend-terminal-snapshot.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import type { AttachmentAvailability } from '../messages/presenter.js';
import { serializeMessageMetadata } from '../message-metadata.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { presentRuntimeSession } from './frontend-runtime-policy.js';
import { StoredFollowups } from '../services/stored-followups.js';
import { operationIdentity } from '../storage/command-boundary.js';
import { MessageAttachmentDtoSchema } from '../contracts/index.js';
import { projectStoredRecoverySnapshot } from './stored-runtime-recovery.js';
import { recoverStoredStandalone } from '../services/stored-standalone-recovery.js';
import type { RuntimeFailureDiagnostic } from '../storage/runtime-storage.js';

type EventContext=Parameters<Parameters<RuntimeStorage['process']>[1]>[1];
type TerminalContext=Pick<EventContext,'guard'|'finishTerminal'>;
export interface StoredRuntimeGraphOptions {
  port:CoreStoragePort;storeId:string;generation:number;registry:EngineRegistry;
  assertExclusiveWriter:()=>Promise<void>;
  collectFileChanges:(runtime:SessionRuntime)=>Promise<TerminalFileChanges>;
  attachmentAvailability:AttachmentAvailability;
  loadAttachmentAvailability?:(paths:readonly string[])=>Promise<AttachmentAvailability>;
  resolveResource:(key:string)=>{label:string;defaultMaxActiveTurns:number}|null;
  prepareRuntime?:StoredRuntimeConnectionOptions['prepareRuntime'];
  prepareInput?:StoredRuntimeConnectionOptions['prepareInput'];
  afterTerminal?:(sessionId:string,completed:boolean)=>Promise<void>;
  capacityChanged?:(resourceKey:string)=>Promise<void>;
  diagnostic:(code:'NATIVE_RUNTIME_UNCONFIRMED'|'NATIVE_PUBLICATION_FAILED',detail?:RuntimeFailureDiagnostic)=>void;
  onOtherEvent?:StoredRuntimeConnectionOptions['onEvent'];
}

/** Native runtime composition, with explicit ports and no import of the legacy application singleton. */
export class StoredRuntimeGraph {
  readonly runtimes=new Map<string,SessionRuntime>();
  readonly hub:StoredFrontendHub;
  readonly sync:StoredFrontendSync;
  readonly connections:StoredRuntimeConnections;
  readonly scheduler:StoredProviderTurnScheduler;
  readonly stop:StoredRuntimeStop;
  readonly responses:StoredInteractionResponses;
  readonly followups:StoredFollowups;
  private closing=false;
  private restoring=false;
  constructor(private readonly options:StoredRuntimeGraphOptions){
    const {port,storeId,generation,registry,assertExclusiveWriter}=options;
    this.hub=new StoredFrontendHub(port,options.loadAttachmentAvailability);
    this.sync=new StoredFrontendSync({hub:this.hub,port,runtimes:this.runtimes,resolveResource:options.resolveResource});
    // Hub admission is ordered; socket delivery must never block the authority queue.
    const stream={hub:{broadcastSession:(...args:Parameters<StoredFrontendHub['broadcastSession']>)=>{
      void this.hub.broadcastSession(...args).then(result=>{if(result.failed)this.report('NATIVE_PUBLICATION_FAILED');},()=>this.report('NATIVE_PUBLICATION_FAILED'));
      return Promise.resolve({sent:0,failed:0});
    }},onPublishFailure:()=>this.report('NATIVE_PUBLICATION_FAILED'),
      onMessageSaved:async(message:import('../storage/contracts.js').StoredMessage,revision:number,_guard:{isCurrent:()=>boolean})=>{
        void this.hub.broadcastMessage({savedMessage:message,revision},{readSession:port.readSession.bind(port),attachmentAvailability:options.attachmentAvailability,isCurrent:()=>!this.closing})
          .then(result=>{if(result.failed)this.report('NATIVE_PUBLICATION_FAILED');},()=>this.report('NATIVE_PUBLICATION_FAILED'));
      }};
    this.connections=new StoredRuntimeConnections({port,storeId,generation,registry,runtimes:this.runtimes,stream,
      ...(options.prepareRuntime?{prepareRuntime:options.prepareRuntime}:{}),...(options.prepareInput?{prepareInput:options.prepareInput}:{}),
      onFailure:(_runtime,_code,detail)=>this.report('NATIVE_RUNTIME_UNCONFIRMED',detail),onRuntimeChanged:async runtime=>{void this.refresh(runtime.sessionId).catch(()=>this.report('NATIVE_PUBLICATION_FAILED'));},
      onEvent:async(runtime,event,context)=>{
        if(event.payload.type==='recovery_snapshot'){
          await projectStoredRecoverySnapshot(runtime,event.payload,context);
          if(event.payload.status!=='inProgress')await this.finish(runtime,event.payload.turnId,event.payload.content||event.payload.error?.message||'恢复的回合未完成',context,event.payload);
          else await this.refresh(runtime.sessionId);
        }else if(event.payload.type==='message_complete')await this.finish(runtime,event.payload.turnId,event.payload.content,context,event.payload);
        else if(event.payload.type==='error'){
          // The cancellation acknowledgement is persisted on this queue next. Waiting here would deadlock it.
          if(runtime.interruptPromise&&event.payload.diagnostic.code?.endsWith('_TURN_INTERRUPTED'))return;
          await this.finish(runtime,runtime.currentTurnId??context.fact?.externalTurnId??runtime.attemptId!,event.payload.diagnostic.userMessage,context);
        }
        else if(event.payload.type==='turn_complete')return; // The final-answer fact, not transport completion, settles the task.
        else if(event.payload.type!=='turn_start'){
          if(options.onOtherEvent)await options.onOtherEvent(runtime,event,context);
          else throw new StorageContractError('NOT_SUPPORTED');
        }
      },
      onClosed:(runtime,context)=>this.finish(runtime,runtime.currentTurnId??runtime.attemptId!,'引擎连接已关闭，回合未完成',context),
      onRecoveryStopped:(runtime,context)=>this.finish(runtime,runtime.currentTurnId??runtime.attemptId!,'已停止',context),
      onTerminalCommitted:async(runtime,effect,_guard)=>{
        // This message is committed. A later runtime may replace its attempt before socket delivery.
        // The hub still rechecks the live recipient's permissions and reloads current session state.
        void this.hub.broadcastTerminal(effect.projection,{readSession:port.readSession.bind(port),attachmentAvailability:options.attachmentAvailability,isCurrent:()=>!this.closing})
          .then(result=>{if(result.failed)this.report('NATIVE_PUBLICATION_FAILED');},()=>this.report('NATIVE_PUBLICATION_FAILED'));
        // Do not wait for a new claim/prepare on the queue whose terminal is still finishing.
        setImmediate(()=>{if(this.closing||this.restoring)return;void this.afterTerminal(runtime.sessionId,runtime.resourceKey,effect.projection.decision.outcome==='completed');});
      },
    });
    const dispatcher=new StoredQueuedTurnDispatcher(port,this.connections);
    const unstarted=new StoredUnstartedTurnFailure(port,{storeId,generation,assertExclusiveWriter,
      unconfirmed:()=>this.report(),committed:async(claim,result)=>{
        try{await this.hub.broadcastTerminal(result,{readSession:port.readSession.bind(port),attachmentAvailability:options.attachmentAvailability,isCurrent:()=>!this.closing});}
        catch{this.report('NATIVE_PUBLICATION_FAILED');}await this.refresh(claim.sessionId);
      }});
    this.scheduler=new StoredProviderTurnScheduler(port,{storeId,generation,assertExclusiveWriter,start:(claim,context)=>dispatcher.start(claim,context),
      failed:(...args)=>unstarted.handle(...args),onFailure:()=>this.report(),changed:options.capacityChanged});
    this.stop=new StoredRuntimeStop(port,{storeId,generation,assertExclusiveWriter,getBinding:id=>this.connections.getBinding(id),onFailure:()=>this.report(),
      onDiagnostic:event=>console.warn(`[Relay:Stop] ${JSON.stringify(event)}`),
      onRequested:id=>this.refresh(id),onStopped:(binding,context)=>this.finish(binding.runtime,binding.runtime.currentTurnId??binding.runtime.attemptId!,'已停止',context)});
    this.responses=new StoredInteractionResponses(port,{storeId,generation,assertExclusiveWriter,getBinding:id=>this.connections.getBinding(id),
      getAdapter:binding=>registry.get(binding.runtime.engine).interactions,onFailure:()=>this.report(),
      submitted:createStoredInteractionProjection(port,{...stream,storeId,generation,changed:id=>this.refresh(id)})});
    this.followups=new StoredFollowups(port,{storeId,generation,assertExclusiveWriter,getBinding:id=>this.connections.getBinding(id),changed:async id=>{void this.refreshFollowups(id).catch(()=>this.report('NATIVE_PUBLICATION_FAILED'));},diagnostic:()=>this.report(),
      accepted:result=>stream.onMessageSaved(result.savedMessage,result.revision,{isCurrent:()=>!this.closing}),
      enqueue:async(record,state)=>{
        const attachments=MessageAttachmentDtoSchema.array().max(10).parse(JSON.parse(record.attachmentsJson));
        const resource=registry.get(state.engineId).concurrency?.resolveResource({sessionId:state.sessionId,projectId:state.projectId});
        if(!resource)throw new StorageContractError('NOT_SUPPORTED');
        const hash=createHash('sha256').update(`${storeId}:followup:${record.id}`).digest('hex');
        const attemptId=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
        const metadata=serializeMessageMetadata({origin:record.origin,replyToAsyncQuestionId:record.replyToAsyncQuestionId??undefined,...(attachments.length?{attachments}:{})});
        const request={protocolVersion:1 as const,storeId,workerGeneration:generation,requestId:randomUUID(),operationId:`followup-enqueue:${record.id}`,principal:{kind:'system',purpose:'scheduler'} as const,
          command:{name:'turn.enqueue' as const,input:{sessionId:state.sessionId,attemptId,messageId:record.id,engineId:state.engineId,resourceKey:resource.resourceKey,content:record.content.trim(),
            metadata:metadata?JSON.parse(metadata):null,expectedPreferencesRevision:state.preferencesRevision,origin:{kind:'followup' as const,followupId:record.id}}}};
        await assertExclusiveWriter();const result=await port.execute(request);
        if(result.state==='unknown'){
          const receipt=await port.lookup({storeId,operationId:request.operationId,principal:request.principal,expected:{commandName:'turn.enqueue',inputDigest:operationIdentity(request).inputDigest}});
          if(receipt.state!=='committed'||receipt.commandName!=='turn.enqueue')throw new StorageContractError('STORAGE_UNAVAILABLE');
        }else if(result.state==='rejected')throw new StorageContractError(result.code);
        if(!this.closing)void this.scheduler.drain(resource.resourceKey).catch(()=>this.report());
      }});
  }
  private report(code:'NATIVE_RUNTIME_UNCONFIRMED'|'NATIVE_PUBLICATION_FAILED'='NATIVE_RUNTIME_UNCONFIRMED',detail?:RuntimeFailureDiagnostic){try{this.options.diagnostic(code,detail);}catch{/* Diagnostics only. */}}
  /** Startup barrier. No scheduler draining or browser admission may run concurrently. */
  async restoreStartup(){
    if(this.closing||this.restoring||this.runtimes.size)throw new StorageContractError('CONFLICT');
    this.restoring=true;
    const {port,storeId,generation,assertExclusiveWriter}=this.options;
    const standalone=await recoverStoredStandalone({port,storeId,generation,assertExclusiveWriter});
    let after:string|null=null,restored=0;
    do{
      await assertExclusiveWriter();const page=await port.readRuntimeRecoveryPage({principal:{kind:'system',purpose:'recovery'},after,limit:32});
      for(const sessionId of page.sessionIds){
        await assertExclusiveWriter();const input=await port.readRuntimeRecoveryTurn({principal:{kind:'system',purpose:'recovery'},sessionId});
        await assertExclusiveWriter();await this.connections.restore(input);restored++;
      }
      if(page.next!==null&&(page.next===after||!page.sessionIds.length))throw new StorageContractError('STORAGE_UNAVAILABLE');after=page.next;
    }while(after!==null);
    this.restoring=false;return{restored,standalone};
  }
  private async finish(runtime:SessionRuntime,turnId:string,content:string,context:TerminalContext,event?:{processContent?:string;finalAnswerItemId?:string}){
    context.guard.assertCurrent();const fileChanges=await this.options.collectFileChanges(runtime);context.guard.assertCurrent();
    const snapshot=buildRuntimeAssistantSnapshot(runtime,{type:'message_complete',turnId,content,...event},{messageId:randomUUID(),now:Date.now(),fileChanges});
    await context.finishTerminal({id:snapshot.messageId,turnId:snapshot.turnId,content:snapshot.content,items:snapshot.items??null,
      metadata:JSON.parse(serializeMessageMetadata(snapshot.metadata)??'null'),durationMs:snapshot.duration??null});
  }
  private async refreshFollowups(sessionId:string){
    await this.refresh(sessionId);
    const outcomes=await Promise.allSettled(this.hub.clients().filter(client=>client.subscribedSessionIds.has(sessionId)).map(client=>
      this.sync.subscribe(client,sessionId,client.activeSubscriptionSessionId===sessionId,false)));
    if(outcomes.some(outcome=>outcome.status==='rejected'))this.report('NATIVE_PUBLICATION_FAILED');
  }
  async refresh(sessionId:string){
    const runtime=this.runtimes.get(sessionId),{port}=this.options;
    const result=await this.hub.broadcastSessionState(sessionId,{readSession:port.readSession.bind(port),readFrontendSync:port.readFrontendSync.bind(port),
      isCurrent:()=>this.runtimes.get(sessionId)===runtime,present:session=>presentRuntimeSession(session,runtime)});
    const outcomes=await Promise.allSettled(this.hub.clients().map(client=>this.sync.refresh(client,true)));
    if(result.failed||outcomes.some(outcome=>outcome.status==='rejected'))this.report('NATIVE_PUBLICATION_FAILED');
  }
  private async afterTerminal(sessionId:string,resourceKey:string|null,completed:boolean){
    void this.refresh(sessionId).catch(()=>this.report('NATIVE_PUBLICATION_FAILED'));
    try{await this.followups.onTerminal(sessionId,completed);await this.options.afterTerminal?.(sessionId,completed);if(resourceKey&&!this.closing)await this.scheduler.drain(resourceKey);}
    catch{this.report();}
  }
  async close(){
    if([...this.runtimes.values()].some(runtime=>runtime.isRunning||runtime.pendingInteractions.size||runtime.interruptPromise))throw new StorageContractError('CONFLICT');
    this.closing=true;await this.scheduler.close();await this.stop.close();await this.responses.close();await this.followups.close();
    for(const sessionId of this.runtimes.keys())await this.connections.closeSession(sessionId);
    this.hub.dispose();
  }
  async suspend(){
    this.closing=true;await this.scheduler.close();await this.stop.close();await this.responses.close();await this.followups.close();
    await this.connections.suspendAll();this.hub.dispose();
  }
}
