import { randomUUID, createHash } from 'node:crypto';
import { publishCommandObservation } from './command-observation.js';
import { buildEngineTurnFact, buildLocalEngineTurnFact } from '../engine/turn-fact-builder.js';
import type { EngineEventEnvelope } from '../engine/events.js';
import type { EngineId } from '../engine/types.js';
import type { EngineTurnFact } from '../engine/turn-facts.js';
import type { CoreCommandInputs, CoreCommandName, CoreCommandOutputs, CoreStoragePort, StorageCommandEnvelope, StoragePrincipal } from './contracts.js';
import { RuntimeEventQueue, RuntimeEventQueueError, type RuntimeFence } from './runtime-event-queue.js';
import { operationIdentity, StorageContractError } from './command-boundary.js';

type Guard = { isCurrent: () => boolean; assertCurrent: () => void };
type TerminalEffect = { projection: CoreCommandOutputs['turn.projectTerminal']; replayed: boolean };
type HostContextInput = Omit<CoreCommandInputs['turn.setHostContext'], 'sessionId' | 'engineId'>;
export type LocalRuntimeEvidence =
  | { type: 'interrupt_confirmed'; userInitiated: boolean }
  | { type: 'connection_closed'; errorCode: string }
  | { type: 'engine_error'; errorCode?: string; retryable: boolean }
  | { type: 'recovery_failed' | 'recovery_interrupted'; errorCode: string };
export class RuntimeStorageError extends Error {
  constructor(readonly reason = 'UNCONFIRMED') { super('RUNTIME_STORAGE_UNCONFIRMED'); }
}
export interface RuntimeFailureDiagnostic {
  sessionId:string;attemptId:string;connectionId:string;stage:string;code:string;eventType?:string;
  pending:number;bytes:number;
}
export function runtimeOperationId(kind: 'fact' | 'terminal' | 'usage' | 'host' | 'capacity' | 'session' | 'started', id: string) {
  return `${kind}:${createHash('sha256').update(id).digest('hex')}`;
}

/** Awaited event/fact/terminal coordinator. It does not connect engines, publish UI or launch tasks itself. */
export class RuntimeStorage {
  private readonly queue: RuntimeEventQueue;
  private readonly ready: Promise<void>;
  private readonly fence: RuntimeFence;
  private readonly principal: Extract<StoragePrincipal, { kind: 'runtime' }>;
  private notifiedFailure = false;
  private terminalConfirmed = false;
  private deltaBatch?:{event:EngineEventEnvelope;handler:Parameters<RuntimeStorage['process']>[1];parts:string[];bytes:number;identities:Set<string>};
  private readonly acceptedDeltas=new Set<string>();
  constructor(private readonly port: CoreStoragePort, private readonly options: {
    storeId: string; generation: number; leaseToken: string; engineId: EngineId;
    runtime: object; principal: Extract<StoragePrincipal, { kind: 'runtime' }>;
    isCurrent: (fence: RuntimeFence) => boolean;
    onFailure: (code: 'RUNTIME_STORAGE_UNCONFIRMED', diagnostic?:RuntimeFailureDiagnostic) => void;
    /** Flush already accepted host-context / usage writes before terminal releases the lease. Must not enqueue on this event queue. */
    beforeTerminal?: (guard: Guard) => void | Promise<void>;
    onTerminalCommitted?: (effect: TerminalEffect, guard: Guard) => void | Promise<void>;
    maxPending?: number; maxBytes?: number;
  }) {
    this.options = Object.freeze({ ...options });
    this.principal = Object.freeze({ ...options.principal });
    this.fence = Object.freeze({ runtime: options.runtime, sessionId: this.principal.sessionId,
      attemptId: this.principal.attemptId, connectionId: this.principal.connectionId, version: this.principal.runtimeVersion });
    this.queue = new RuntimeEventQueue(options.isCurrent, { maxPending: options.maxPending, maxBytes: options.maxBytes });
    this.ready = Promise.resolve().then(async () => {
      await port.registerRuntime({ storeId: options.storeId, workerGeneration: options.generation,
        leaseToken: options.leaseToken, runtime: this.principal });
    });
    void this.ready.catch(error => this.reportFailure(error,'register'));
  }
  private reportFailure(error?:unknown,stage='storage',eventType?:string) {
    if (this.notifiedFailure) return;
    this.notifiedFailure = true;
    this.queue.poison();
    // Never log provider text, SQL, paths or arbitrary Error.message values.
    const code=error instanceof RuntimeEventQueueError?`RUNTIME_EVENT_${error.code}`
      :error instanceof StorageContractError?error.code:error instanceof RuntimeStorageError?error.reason:'UNCLASSIFIED';
    const health=this.queue.health();
    try { if (this.options.isCurrent(this.fence)) this.options.onFailure('RUNTIME_STORAGE_UNCONFIRMED',{
      sessionId:this.principal.sessionId,attemptId:this.principal.attemptId,connectionId:this.principal.connectionId,
      stage,code,...(eventType?{eventType}:{}),pending:health.pending,bytes:health.bytes,
    }); } catch { /* Diagnostic only. */ }
  }
  private enqueue<T>(bytes:number,work:(guard:Guard)=>Promise<T>){
    this.flushDeltas();
    if(this.terminalConfirmed)return Promise.resolve({state:'stale' as const});
    return this.queue.enqueue(this.fence,bytes,async guard=>{
      if(this.terminalConfirmed)return{ignored:true as const};
      return{ignored:false as const,value:await work(guard)};
    }).then(result=>result.state==='stale'||result.value.ignored?{state:'stale' as const}:{state:'handled' as const,value:result.value.value});
  }
  private async persist<K extends CoreCommandName>(operationId: string, name: K, input: CoreCommandInputs[K], guard: Guard): Promise<{ value: CoreCommandOutputs[K]; replayed: boolean }> {
    guard.assertCurrent();
    const request = { protocolVersion: 1, storeId: this.options.storeId, requestId: randomUUID(),
      workerGeneration: this.options.generation, operationId, principal: this.principal,
      command: { name, input } } as StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } };
    const result = await this.port.execute<K>(request);
    guard.assertCurrent();
    if (result.state === 'committed') return { value: result.value, replayed: result.replayed };
    if (result.state === 'unknown') {
      const record = await this.port.lookup({ storeId: this.options.storeId, operationId, principal: this.principal,
        expected: { commandName: name, inputDigest: operationIdentity(request).inputDigest } });
      guard.assertCurrent();
      if (record.state === 'committed' && record.commandName === name) {
        publishCommandObservation(this.port,request,{state:'committed',operationId,committedAt:record.committedAt,replayed:true,value:record.value as CoreCommandOutputs[K]});
        return { value: record.value as CoreCommandOutputs[K], replayed: true };
      }
    }
    throw new RuntimeStorageError(result.state==='rejected'?result.code:'UNCONFIRMED');
  }
  private async terminal(input: CoreCommandInputs['turn.projectTerminal'], guard: Guard): Promise<TerminalEffect> {
    const captured = structuredClone(input);
    guard.assertCurrent();
    await this.options.beforeTerminal?.(guard);
    guard.assertCurrent();
    const result = await this.persist(runtimeOperationId('terminal', captured.decision.id), 'turn.projectTerminal', captured, guard);
    this.terminalConfirmed = true;
    const effect = { projection: result.value, replayed: result.replayed };
    guard.assertCurrent();
    await this.options.onTerminalCommitted?.(effect, guard);
    guard.assertCurrent();
    return effect;
  }
  private usage(input: CoreCommandInputs['turn.updateUsage']['usage'], guard: Guard,sessionUsage?:CoreCommandInputs['turn.updateUsage']['sessionUsage']) {
    return this.persist(runtimeOperationId('usage', randomUUID()), 'turn.updateUsage', {
      sessionId: this.principal.sessionId, attemptId: this.principal.attemptId, usage: structuredClone(input),
      ...(sessionUsage?{sessionUsage:structuredClone(sessionUsage)}:{}),
    }, guard);
  }
  private async finishFromFact(factId: string, message: CoreCommandInputs['turn.projectTerminal']['message'], guard: Guard): Promise<TerminalEffect> {
    const captured=structuredClone(message);
    guard.assertCurrent();await this.options.beforeTerminal?.(guard);guard.assertCurrent();
    const result=await this.persist(runtimeOperationId('terminal',`fact:${factId}`),'turn.finishFromFact',{
      sessionId:this.principal.sessionId,factId,message:captured,
    },guard);
    this.terminalConfirmed = true;
    const effect={projection:result.value,replayed:result.replayed};
    guard.assertCurrent();await this.options.onTerminalCommitted?.(effect,guard);guard.assertCurrent();return effect;
  }
  private hostContext(input: HostContextInput, guard: Guard) {
    return this.persist(runtimeOperationId('host', randomUUID()), 'turn.setHostContext', {
      ...structuredClone(input), sessionId: this.principal.sessionId, engineId: this.options.engineId,
    }, guard);
  }
  private capacity(event: CoreCommandInputs['capacity.observe']['event'], observationId: string, guard: Guard) {
    return this.persist(runtimeOperationId('capacity', observationId), 'capacity.observe', {
      sessionId: this.principal.sessionId, attemptId: this.principal.attemptId, event: structuredClone(event),
    }, guard);
  }
  private automaticResponses(guard:Guard){return{
    prepareAutoResponse:(input:Omit<CoreCommandInputs['turn.prepareAutoResponse'],'sessionId'>)=>this.persist(runtimeOperationId('session',JSON.stringify([this.principal,'auto',input.interactionId])),
      'turn.prepareAutoResponse',{...input,sessionId:this.principal.sessionId},guard),
    authorizeAutoResponse:(jobId:string)=>this.persist(runtimeOperationId('session',randomUUID()),'turn.authorizeAutoResponse',{sessionId:this.principal.sessionId,jobId},guard),
    confirmAutoResponse:(job:CoreCommandOutputs['turn.confirmAutoResponse'])=>this.persist(runtimeOperationId('session',JSON.stringify([this.principal,'auto-confirm',job.jobId])),
      'turn.confirmAutoResponse',{sessionId:this.principal.sessionId,jobId:job.jobId,claimToken:job.claimToken,requestDigest:job.requestDigest,responseDigest:job.responseDigest},guard),
  };}
  private async asyncQuestion(input:Omit<CoreCommandInputs['turn.recordAsyncQuestion'],'sessionId'>,guard:Guard){
    const result=await this.persist(runtimeOperationId('session',JSON.stringify([this.principal,'async-question',input.item.id])),
      'turn.recordAsyncQuestion',{...input,sessionId:this.principal.sessionId},guard);guard.assertCurrent();
    const state=await this.port.readRuntimeAsyncQuestion({principal:this.principal,questionId:input.item.id});guard.assertCurrent();
    return{...result,value:{...result.value,open:state.open,...(result.replayed?{savedMessage:null}:{})}};
  }
  standaloneEvent(handler:(context:ReturnType<RuntimeStorage['automaticResponses']>&{guard:Guard;
    persistAsyncQuestion:(input:Omit<CoreCommandInputs['turn.recordAsyncQuestion'],'sessionId'>)=>ReturnType<RuntimeStorage['asyncQuestion']>;
    begin:(input:Omit<CoreCommandInputs['turn.beginStandalone'],'sessionId'>)=>Promise<void>;
    resolve:(input:Omit<CoreCommandInputs['turn.resolveStandalone'],'sessionId'>)=>Promise<CoreCommandOutputs['turn.resolveStandalone']>;
    close:(interactionId:string)=>Promise<CoreCommandOutputs['turn.closeStandalone']>;
  })=>Promise<void>){
    if(!this.terminalConfirmed)return Promise.reject(new RuntimeStorageError());
    return this.queue.enqueue(this.fence,512,async guard=>{await this.ready;guard.assertCurrent();await handler({...this.automaticResponses(guard),guard,
      persistAsyncQuestion:input=>this.asyncQuestion(input,guard),
      begin:async input=>{await this.persist(runtimeOperationId('session',JSON.stringify([this.principal,'standalone',input.interactionId])),'turn.beginStandalone',{...input,sessionId:this.principal.sessionId},guard);},
      resolve:async input=>(await this.persist(runtimeOperationId('session',JSON.stringify([this.principal,'standalone-resolve',input.interactionId])),'turn.resolveStandalone',{...input,sessionId:this.principal.sessionId},guard)).value,
      close:async interactionId=>(await this.persist(runtimeOperationId('session',JSON.stringify([this.principal,'standalone-close',interactionId])),'turn.closeStandalone',{interactionId,sessionId:this.principal.sessionId},guard)).value,
    });});
  }
  /** Interrupt / close / recovery callbacks must commit evidence before their terminal handler. */
  processLocal(evidence: LocalRuntimeEvidence, handler: (context: {
    fact: EngineTurnFact; guard: Guard;
    finishTerminal: (message: CoreCommandInputs['turn.projectTerminal']['message']) => Promise<TerminalEffect>;
    persistTerminal: (input: CoreCommandInputs['turn.projectTerminal']) => Promise<TerminalEffect>;
  }) => void | Promise<void>, observedAt = Date.now()) {
    if(this.terminalConfirmed)return Promise.resolve({state:'stale' as const});
    const { captured, bytes } = this.capture(evidence);
    const source = captured.type === 'connection_closed' ? 'process_exit'
      : captured.type === 'recovery_failed' || captured.type === 'recovery_interrupted' ? 'recovery' : 'local';
    const { type, ...payload } = captured;
    const fact = buildLocalEngineTurnFact({ context: { sessionId: this.principal.sessionId, attemptId: this.principal.attemptId,
      connectionId: this.principal.connectionId, engineId: this.options.engineId, userStopRequested: false },
      factType: type, payload, source, observedAt });
    const result = this.enqueue(bytes, async (guard) => {
      await this.ready; guard.assertCurrent();
      const stored = await this.persist(runtimeOperationId('fact', fact.id), 'turn.appendFact', { fact }, guard);
      guard.assertCurrent();
      await handler({ fact: stored.value.fact, guard, persistTerminal: (input) => this.terminal(input, guard),
        finishTerminal:(message)=>this.finishFromFact(stored.value.fact.id,message,guard) });
      guard.assertCurrent();
    });
    void result.catch(error => this.reportFailure(error));
    return result;
  }
  prepareRecovery(){return this.enqueue(128,async guard=>{await this.ready;guard.assertCurrent();return this.persist(runtimeOperationId('session',JSON.stringify([this.principal,'recovery-prepare'])),'turn.prepareRecovery',{sessionId:this.principal.sessionId},guard);});}
  process(event: EngineEventEnvelope, handler: (event: EngineEventEnvelope, context: {
    fact: EngineTurnFact | null; guard: Guard;
    finishTerminal: (message: CoreCommandInputs['turn.projectTerminal']['message']) => Promise<TerminalEffect>;
    persistStarted: () => Promise<{ value: CoreCommandOutputs['turn.projectStarted']; replayed: boolean }>;
    persistTerminal: (input: CoreCommandInputs['turn.projectTerminal']) => Promise<TerminalEffect>;
    persistUsage: (usage: CoreCommandInputs['turn.updateUsage']['usage'],sessionUsage?:CoreCommandInputs['turn.updateUsage']['sessionUsage']) => ReturnType<RuntimeStorage['usage']>;
    persistCompaction:(input:Omit<CoreCommandInputs['turn.recordCompaction'],'sessionId'>)=>Promise<{value:CoreCommandOutputs['turn.recordCompaction'];replayed:boolean}>;
    persistInteractions:(pendingCount:number)=>Promise<{value:CoreCommandOutputs['turn.projectInteractions'];replayed:boolean}>;
    persistRecovered:(input:Omit<CoreCommandInputs['turn.projectRecovered'],'sessionId'>)=>Promise<{value:CoreCommandOutputs['turn.projectRecovered'];replayed:boolean}>;
    persistAsyncQuestion:(input:Omit<CoreCommandInputs['turn.recordAsyncQuestion'],'sessionId'>)=>ReturnType<RuntimeStorage['asyncQuestion']>;
    prepareAutoResponse:(input:Omit<CoreCommandInputs['turn.prepareAutoResponse'],'sessionId'>)=>Promise<{value:CoreCommandOutputs['turn.prepareAutoResponse'];replayed:boolean}>;
    authorizeAutoResponse:(jobId:string)=>Promise<{value:CoreCommandOutputs['turn.authorizeAutoResponse'];replayed:boolean}>;
    confirmAutoResponse:(job:CoreCommandOutputs['turn.confirmAutoResponse'])=>Promise<{value:CoreCommandOutputs['turn.confirmAutoResponse'];replayed:boolean}>;
    persistHostContext: (input: HostContextInput) => ReturnType<RuntimeStorage['hostContext']>;
    persistCapacity: (event: CoreCommandInputs['capacity.observe']['event']) => ReturnType<RuntimeStorage['capacity']>;
  }) => void | Promise<void>) {
    this.flushDeltas();
    if(this.terminalConfirmed)return Promise.resolve({state:'stale' as const});
    if (event.engineId !== this.options.engineId) return Promise.resolve({ state: 'stale' as const });
    let captured: EngineEventEnvelope;
    let bytes: number;
    try { captured = structuredClone(event); bytes = Buffer.byteLength(JSON.stringify(captured)); }
    catch { const error=new RuntimeEventQueueError('INVALID_EVENT');this.reportFailure(error,'capture');return Promise.reject(error); }
    const fact = buildEngineTurnFact(captured, { sessionId: this.principal.sessionId, attemptId: this.principal.attemptId,
      engineId: this.options.engineId, connectionId: this.principal.connectionId, userStopRequested: false });
    const result = this.enqueue(bytes, async (guard) => {
      await this.ready; guard.assertCurrent();
      const committed = fact ? (await this.persist(runtimeOperationId('fact', fact.id), 'turn.appendFact', { fact }, guard)).value.fact : null;
      guard.assertCurrent();
      await handler(captured, { fact: committed, guard, persistTerminal: (input) => this.terminal(input, guard),
        finishTerminal:(message)=>{if(!committed)throw new RuntimeStorageError();return this.finishFromFact(committed.id,message,guard);},
        persistStarted: () => {
          if (!committed || captured.payload.type !== 'turn_start' || committed.factType !== 'turn_started') throw new RuntimeStorageError();
          return this.persist(runtimeOperationId('started', committed.id), 'turn.projectStarted', {
            sessionId:this.principal.sessionId,factId:committed.id,externalTurnId:captured.payload.turnId,
          },guard);
        },
        persistUsage: (input,sessionUsage) => this.usage(input, guard,sessionUsage), persistHostContext: (input) => this.hostContext(input, guard),
        persistCompaction:input=>this.persist(runtimeOperationId('host',JSON.stringify([this.principal,'compaction',input.externalSessionId,input.externalTurnId])),
          'turn.recordCompaction',{...input,sessionId:this.principal.sessionId},guard),
        persistInteractions:pendingCount=>this.persist(runtimeOperationId('session',randomUUID()),'turn.projectInteractions',{sessionId:this.principal.sessionId,pendingCount},guard),
        persistRecovered:input=>this.persist(runtimeOperationId('session',randomUUID()),'turn.projectRecovered',{...input,sessionId:this.principal.sessionId},guard),
        persistAsyncQuestion:input=>this.asyncQuestion(input,guard),
        ...this.automaticResponses(guard),
        persistCapacity: (input) => this.capacity(input, `${this.principal.attemptId}:${this.principal.connectionId}:${captured.meta.eventId
          ?? `${captured.meta.source}:${captured.meta.sequence}:${captured.meta.observedAt}`}`, guard) });
      guard.assertCurrent();
    });
    void result.catch(error => this.reportFailure(error,'event',captured.payload.type));
    return result;
  }
  /** Ownership for existing void engine callbacks: failure is observed and halts this attempt's queue. */
  accept(event: EngineEventEnvelope, handler: Parameters<RuntimeStorage['process']>[1]): void {
    try {
      if(event.payload.type==='delta'&&!this.terminalConfirmed&&!this.queue.health().failed){
        const identity=`${event.meta.source}:${event.meta.eventId??event.meta.sequence}`;
        if(this.acceptedDeltas.has(identity))return;
        this.acceptedDeltas.add(identity);if(this.acceptedDeltas.size>512)this.acceptedDeltas.delete(this.acceptedDeltas.values().next().value!);
        const batch=this.deltaBatch,previous=batch?.event;
        const same=previous?.payload.type==='delta'&&previous.engineId===event.engineId&&previous.meta.source===event.meta.source
          &&previous.meta.externalSessionId===event.meta.externalSessionId&&previous.meta.externalTurnId===event.meta.externalTurnId
          &&previous.payload.itemId===event.payload.itemId&&previous.payload.phase===event.payload.phase;
        const bytes=Buffer.byteLength(event.payload.content);
        if(same&&batch&&batch.bytes+bytes<=64*1024&&batch.identities.size<4096){
          if(!batch.identities.has(identity)){batch.parts.push(event.payload.content);batch.bytes+=bytes;batch.identities.add(identity);}return;
        }
        this.flushDeltas();
        this.deltaBatch={event:structuredClone(event),handler,parts:[event.payload.content],bytes,identities:new Set([identity])};
        queueMicrotask(()=>this.flushDeltas());return;
      }
      void this.process(event, handler).catch(error => this.reportFailure(error,'event',event.payload.type));
    }catch(error){this.reportFailure(error,'event',event.payload.type);}
  }
  private flushDeltas(){
    const batch=this.deltaBatch;if(!batch)return;this.deltaBatch=undefined;
    if(batch.event.payload.type!=='delta')return;
    batch.event.payload.content=batch.parts.join('');
    void this.process(batch.event,batch.handler).catch(error=>this.reportFailure(error,'event','delta'));
  }
  private capture<T>(input: T) {
    try {
      const captured = structuredClone(input);
      return { captured, bytes: Buffer.byteLength(JSON.stringify(captured)) };
    } catch {
      const error=new RuntimeEventQueueError('INVALID_EVENT');this.reportFailure(error,'capture');throw error;
    }
  }
  /** For callbacks outside an event handler. Event handlers must use context.persist* to avoid nested-queue deadlocks. */
  reconcileInteractionProjection<T>(work:(guard:Guard)=>Promise<T>){
    // A confirmed protocol reply may trail terminal settlement. Only the still-owned binding may repair its interaction projection.
    return this.queue.enqueue(this.fence,256,async guard=>{await this.ready;guard.assertCurrent();return work(guard);});
  }
  updateUsage(usage: CoreCommandInputs['turn.updateUsage']['usage']) {
    if(this.terminalConfirmed)return Promise.resolve({state:'stale' as const});
    const { captured, bytes } = this.capture(usage);
    const result = this.enqueue(bytes, async (guard) => {
      await this.ready; guard.assertCurrent(); return this.usage(captured, guard);
    });
    void result.catch(error => this.reportFailure(error,'usage'));
    return result;
  }
  setHostContext(input: HostContextInput) {
    if(this.terminalConfirmed)return Promise.resolve({state:'stale' as const});
    const { captured, bytes } = this.capture(input);
    const result = this.enqueue(bytes, async (guard) => {
      await this.ready; guard.assertCurrent(); return this.hostContext(captured, guard);
    });
    void result.catch(error => this.reportFailure(error,'host'));
    return result;
  }
  /** Actual onSessionReady boundary: never continue engine initialization on stale or unknown storage. */
  async bindExternalSession(expectedExternalSessionId: string | null, externalSessionId: string): Promise<void> {
    if(this.terminalConfirmed)throw new RuntimeStorageError();
    const { captured, bytes } = this.capture({ sessionId: this.principal.sessionId, engineId: this.options.engineId,
      expectedExternalSessionId, externalSessionId });
    const operationId = runtimeOperationId('session', JSON.stringify([this.principal, captured]));
    const pending = this.enqueue(bytes, async (guard) => {
      await this.ready; guard.assertCurrent();
      return this.persist(operationId, 'turn.bindExternalSession', captured, guard);
    });
    try {
      const result = await pending;
      if (result.state !== 'handled') throw new RuntimeStorageError();
    } catch (error) {
      if(!this.terminalConfirmed)this.reportFailure(error,'bind'); throw error;
    }
  }
  finish(input: CoreCommandInputs['turn.projectTerminal']) {
    if(this.terminalConfirmed)return Promise.resolve({state:'stale' as const});
    const { captured, bytes } = this.capture(input);
    const result = this.enqueue(bytes, async (guard) => {
      await this.ready; guard.assertCurrent(); return this.terminal(captured, guard);
    });
    void result.catch(error => this.reportFailure(error,'terminal'));
    return result;
  }
  health() { return this.queue.health(); }
  isTerminalCommitted() { return this.terminalConfirmed; }
  /** External lifecycle only; never await from inside an event handler. */
  async drain() { this.flushDeltas();await this.ready; await this.queue.drain(); }
  async close() {
    this.flushDeltas();
    try { await this.queue.close(); await this.ready; }
    finally {
      await this.port.retireRuntime({ storeId: this.options.storeId, workerGeneration: this.options.generation, runtime: this.principal });
    }
  }
}
