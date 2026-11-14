import type { CoreStoragePort } from '../storage/contracts.js';
import { RuntimeStorage } from '../storage/runtime-storage.js';
import type { RuntimeFailureDiagnostic } from '../storage/runtime-storage.js';
import type { EngineEventEnvelope } from './events.js';
import type { SessionRuntime } from './runtime.js';
import { observeEnginePerformanceEvent } from './runtime-performance.js';

type Handler = Parameters<RuntimeStorage['process']>[1];
type Options = {
  storeId: string; generation: number; runtimeVersion: number;
  /** Check the actual runtime registry; an object kept alive by old callbacks is insufficient. */
  isOwned: (runtime: SessionRuntime) => boolean;
  onFailure: (code: 'RUNTIME_STORAGE_UNCONFIRMED',diagnostic?:RuntimeFailureDiagnostic) => void;
  beforeTerminal?: ConstructorParameters<typeof RuntimeStorage>[1]['beforeTerminal'];
  onTerminalCommitted?: ConstructorParameters<typeof RuntimeStorage>[1]['onTerminalCommitted'];
};
const bindings = new WeakMap<SessionRuntime, { version: number; binding: StoredRuntimeEvents }>();

/** Opt-in replacement for routeEngineEvent, activated only with the complete async service graph.
 * It never invokes the legacy synchronous fact sink or opens a database on the main thread.
 */
export class StoredRuntimeEvents {
  readonly storage: RuntimeStorage;
  private retired = false;
  constructor(readonly runtime: SessionRuntime, port: CoreStoragePort, options: Options) {
    const isOwned = options.isOwned;
    const { sessionId, attemptId, engineConnectionId: connectionId, leaseToken, engine } = runtime;
    const previous = bindings.get(runtime);
    if (!attemptId || !connectionId || !leaseToken || !isOwned(runtime)
      || !Number.isSafeInteger(options.runtimeVersion) || options.runtimeVersion < 1
      || previous && options.runtimeVersion <= previous.version) throw new Error('RUNTIME_STORAGE_CONFLICT');
    const version = options.runtimeVersion;
    this.storage = new RuntimeStorage(port, {
      storeId: options.storeId, generation: options.generation, leaseToken, engineId: engine, runtime,
      principal: { kind: 'runtime', sessionId, attemptId, connectionId, runtimeVersion: version },
      isCurrent: (fence) => !this.retired && bindings.get(runtime)?.binding === this && isOwned(runtime)
        && fence.runtime === runtime && fence.version === version && runtime.sessionId === sessionId
        && runtime.engine === engine && runtime.attemptId === attemptId && runtime.leaseToken === leaseToken
        && runtime.engineConnectionId === connectionId,
      onFailure: options.onFailure, beforeTerminal: options.beforeTerminal, onTerminalCommitted: options.onTerminalCommitted,
    });
    bindings.set(runtime, { version, binding: this });
  }
  private async handle(event: EngineEventEnvelope, context: Parameters<Handler>[1], handler: Handler) {
    context.guard.assertCurrent();
    if (event.payload.type === 'turn_start') {
      // Historical starts are evidence only; never re-open a turn or publish them as a live start.
      if (event.meta.source !== 'realtime' && event.meta.source !== 'request_response') return;
      const started = await context.persistStarted();
      context.guard.assertCurrent();
      this.runtime.currentTurnId = started.value.externalTurnId;
      this.runtime.turnStartTime = started.value.startedAt;
      if (started.value.status === 'stopping') this.runtime.isStopping = true;
    }
    observeEnginePerformanceEvent(this.runtime, event.payload);
    try { await this.runtime.observeEngineEvent?.(event); }
    catch { /* Optional diagnostics cannot fail the authoritative write chain. */ }
    context.guard.assertCurrent();
    await handler(event, context);
    context.guard.assertCurrent();
  }
  route(event: EngineEventEnvelope, handler: Handler) {
    return this.storage.process(event, (captured, context) => this.handle(captured, context, handler));
  }
  /** Passed directly through the actual adapter/HostContext/performance wrappers. */
  sessionReady(expectedExternalSessionId: string | null): (externalSessionId: string) => Promise<void> {
    return (externalSessionId) => this.storage.bindExternalSession(expectedExternalSessionId, externalSessionId);
  }
  /** Own the Promise at the engine's void onEvent boundary. */
  accept(event: EngineEventEnvelope, handler: Handler): void {
    this.storage.accept(event, (captured, context) => this.handle(captured, context, handler));
  }
  /** Keep connection identity intact until its closing evidence/terminal work settles. */
  connectionClosed(handler:Parameters<RuntimeStorage['processLocal']>[1]) {
    return this.storage.processLocal({type:'connection_closed',errorCode:`${this.runtime.engine.toUpperCase()}_CONNECTION_CLOSED`},handler);
  }
  async close() {
    this.retired = true; // Invalidate before awaiting accepted work or Worker retirement.
    await this.storage.close();
  }
}
