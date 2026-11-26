import { canonicalJson } from '../storage/command-boundary.js';
import type { CoreStoragePort, StoredSessionSync } from '../storage/contracts.js';
import { RELAY_PROTOCOL_VERSION, TurnQueueSnapshotDtoSchema, type FrontendEvent } from '../contracts/index.js';
import type { SessionRuntime } from '../engine/runtime.js';
import type { FrontendClient } from './frontend-client-hub.js';
import { StoredFrontendHub, type SyncContext, type PreparedFrontendSync } from './stored-frontend-hub.js';
import { presentProcessItems } from '../messages/presenter.js';
import { collectPendingApprovals } from './pending-approvals.js';
import { presentRuntimeSession } from './frontend-runtime-policy.js';

function stale():never{throw new Error('FRONTEND_SNAPSHOT_STALE');}
function matchesAttempt(runtime:SessionRuntime,attemptId:string|null){return runtime.attemptId===attemptId||attemptId===null&&!runtime.isRunning&&!runtime.isStopping&&runtime.pendingInteractions.size>0&&[...runtime.pendingInteractions.values()].every(p=>p.standalone);}
function runtimeStamp(runtime:SessionRuntime) {
  return canonicalJson([runtime.attemptId,runtime.engineConnectionId,Boolean(runtime.engineConnection),runtime.engine,runtime.isRunning,runtime.isStopping,runtime.isRecovering,
    [...runtime.pendingInteractions].map(([id,p])=>[id,p.createdAt,p.connectionId])]);
}
/** Candidate synchronization adapter. Every dependency is explicit; it never starts engines or imports legacy services. */
export class StoredFrontendSync {
  constructor(private readonly options:{hub:StoredFrontendHub;port:Pick<CoreStoragePort,'readFrontendSync'|'readSessionSync'>;
    runtimes:ReadonlyMap<string,SessionRuntime>;
    resolveResource:(key:string)=>{label:string;defaultMaxActiveTurns:number}|null;
  }){this.options=Object.freeze({...options});}
  private pendingIds(){
    const ids:string[]=[];let count=0;
    for(const [id,runtime] of this.options.runtimes){
      count+=runtime.pendingInteractions.size;
      if(count>512)throw new Error('FRONTEND_SNAPSHOT_OVERLOADED');
      if(runtime.pendingInteractions.size)ids.push(id);
    }
    return ids.sort();
  }
  private pendingBatch(data:Awaited<ReturnType<CoreStoragePort['readFrontendSync']>>,ids:string[]) {
    if(canonicalJson(this.pendingIds())!==canonicalJson(ids))stale();
    const captured=data.sessions.flatMap((session)=>{
      const runtime=this.options.runtimes.get(session.id);if(!runtime||!runtime.pendingInteractions.size)return [];
      if(runtime.engine!==session.engine||!matchesAttempt(runtime,session.activeAttemptId))stale();
      return [{session,runtime,stamp:runtimeStamp(runtime)}];
    });
    if(captured.reduce((n,c)=>n+c.runtime.pendingInteractions.size,0)>512)throw new Error('FRONTEND_SNAPSHOT_OVERLOADED');
    const approvals=collectPendingApprovals(captured.map(({session,runtime})=>({sessionId:session.id,sessionTitle:session.title,engine:session.engine,
      items:runtime.turnItems,pending:[...runtime.pendingInteractions].map(([interactionId,p])=>({interactionId,createdAt:p.createdAt}))})));
    approvals.push(...(data.asyncQuestions??[]));
    approvals.sort((a,b)=>a.createdAt-b.createdAt||a.sessionId.localeCompare(b.sessionId)||a.id.localeCompare(b.id));
    return {event:{type:'pending_approvals_snapshot',approvals} as const,isCurrent:()=>canonicalJson(this.pendingIds())===canonicalJson(ids)
      &&captured.every(({session,runtime,stamp})=>this.options.runtimes.get(session.id)===runtime&&runtimeStamp(runtime)===stamp)};
  }
  private async initial(context:SyncContext,full=true,live=false):Promise<()=>PreparedFrontendSync>{
    const ids=this.pendingIds(),data=await this.options.port.readFrontendSync({...context,runtimeSessionIds:ids});
    const expected=canonicalJson(data),recheck=async()=>canonicalJson(await this.options.port.readFrontendSync({...context,runtimeSessionIds:ids}))===expected;
    return ()=>{
      const pending=this.pendingBatch(data,ids);
      const events:FrontendEvent[]=full?[{type:'protocol_info',protocolVersion:RELAY_PROTOCOL_VERSION},{type:'session_reads',receipts:data.receipts},pending.event]:[{...pending.event,...(live?{live:true}:{})}];
      return {role:data.role,events,isCurrent:pending.isCurrent,recheck};
    };
  }
  private async session(context:SyncContext,sessionId:string,includeMessages:boolean):Promise<()=>PreparedFrontendSync>{
    const ids=this.pendingIds();
    const authorizedIds=[...new Set([...ids,sessionId])].sort();
    const [data,access]=await Promise.all([this.options.port.readSessionSync({principal:context.principal,sessionId,includeMessages}),
      this.options.port.readFrontendSync({...context,runtimeSessionIds:authorizedIds})]);
    if(data.role!==access.role)stale();
    const expected=canonicalJson(access),recheck=async()=>canonicalJson(await this.options.port.readFrontendSync({...context,runtimeSessionIds:authorizedIds}))===expected;
    return ()=>{
      const pending=this.pendingBatch(access,ids);
      let runtime=this.options.runtimes.get(sessionId);
      if(runtime&&(runtime.engine!==data.session.engine||!matchesAttempt(runtime,data.activeAttemptId))){
        if(runtime.isRunning||runtime.pendingInteractions.size)stale();runtime=undefined;
      }
      // Startup/recovery must supply or reconcile an active runtime; viewing must not invent an idle snapshot.
      if(!runtime&&data.activeAttemptId&&['pending','processing','recovering','awaiting_action','stopping'].includes(data.session.status))stale();
      const captured=runtime,stamp=runtime?runtimeStamp(runtime):null;
      const queue=this.queue(data.queue);
      const live={protocolVersion:RELAY_PROTOCOL_VERSION,sessionId,isRunning:runtime?.isRunning??false,
        currentContent:runtime?(runtime.finalAnswerContent||(runtime.commentaryContent?'':runtime.currentContent)):'',
        ...(runtime?.commentaryContent?{processContent:runtime.commentaryContent}:{}),
        processSteps:presentProcessItems(runtime?.turnItems??[],runtime?.isRunning?'in_progress':'completed'),
        ...(runtime?.processTimeline.length?{processTimeline:structuredClone(runtime.processTimeline)}:{}),startTime:runtime?.turnStartTime??null,
        requestForwarded:runtime?.requestForwarded??false,isStopping:runtime?.isStopping??false,queue};
      const events:FrontendEvent[]=[{type:'session_updated',sessionId,snapshot:true,session:presentRuntimeSession(data.session,runtime)}];
      if(includeMessages){if(!data.page||data.page.unchanged)stale();events.push({type:'sync_state',...live,messageRevision:data.page.page.revision,
        messageHasMore:data.page.page.hasMore,messageNextCursor:data.page.page.nextCursor,messages:data.page.page.messages});}
      else events.push({type:'runtime_sync_state',...live});
      if(data.followups!==null)events.push({type:'session_followup_snapshot',sessionId,followups:data.followups});
      if(runtime?.modelInfo)events.push({...structuredClone(runtime.modelInfo),type:'model_info',sessionId});
      const currentUsage=runtime?.isRunning?runtime.latestTokenUsage:null,usage=currentUsage??data.usage;
      if(usage)events.push({type:'token_usage',sessionId,usage:structuredClone(usage),...(currentUsage?{currentTurn:true,...(runtime?.tokenUsage?{turnOutputUsage:structuredClone(runtime.tokenUsage)}:{})}:{})});
      events.push(pending.event);canonicalJson(events,7*1024*1024);
      return {role:data.role,events,recheck,isCurrent:()=>pending.isCurrent()&&(captured?this.options.runtimes.get(sessionId)===captured&&runtimeStamp(captured)===stamp:
        !this.options.runtimes.get(sessionId)?.isRunning&&!this.options.runtimes.get(sessionId)?.pendingInteractions.size)};
    };
  }
  private queue(value:StoredSessionSync['queue']){
    if(!value)return null;
    const resource=this.options.resolveResource(value.resourceKey);if(!resource)throw new Error('FRONTEND_QUEUE_RESOURCE_UNAVAILABLE');
    return TurnQueueSnapshotDtoSchema.parse({...value,label:resource.label,maxActiveTurns:value.maxActiveTurns??resource.defaultMaxActiveTurns});
  }
  async connect(client:FrontendClient){if(!await this.options.hub.add(client))return false;return this.options.hub.initialize(client,(context)=>this.initial(context));}
  refresh(client:FrontendClient,live=false){return this.options.hub.initialize(client,context=>this.initial(context,false,live));}
  subscribe(client:FrontendClient,sessionId:string,active=true,includeMessages=true){
    return this.options.hub.synchronize(client,sessionId,{active,includeMessages},(context)=>this.session(context,sessionId,active&&includeMessages));
  }
  unsubscribe(client:FrontendClient,sessionId:string){this.options.hub.unsubscribe(client,sessionId);return this.options.hub.initialize(client,(context)=>this.initial(context,false));}
}
