import type { EngineConnection, EngineConnectionOptions, EngineAvailability } from './adapter.js';
import type { EngineDiagnostic, EngineDiagnosticContext } from './diagnostics.js';
import type { EngineLocalHealth } from './health.js';
import type { EngineEventEnvelope } from './events.js';
import type { EngineTerminalFactContext, EngineTurnFact } from './turn-facts.js';
import type { EngineConcurrencyContext, EngineConcurrencyResource } from './concurrency/types.js';
import type {
  EngineInteractionRequest,
  InteractionResponseCommand,
  NormalizedInteraction,
} from './interactions.js';
export type { EngineModelAdapter } from './models/types.js';

export interface EngineRuntimeAdapter {
  connect(options: EngineConnectionOptions): EngineConnection;
}

export interface EngineAvailabilityAdapter {
  getCurrent(): EngineAvailability;
}

export interface EngineDiagnosticAdapter {
  classify(error: unknown, context: EngineDiagnosticContext): EngineDiagnostic;
}

export interface EngineHealthAdapter {
  inspectLocal(): Promise<EngineLocalHealth>;
}

export interface EngineConcurrencyAdapter {
  resolveResource(context: EngineConcurrencyContext): EngineConcurrencyResource;
}

export interface EngineProtocolAdapter {}
export interface EngineSessionAdapter {
  /** 从指定锚点分叉出继承历史的新外部会话;latest 取引擎当前末尾,turn 按第 N 轮锚定。 */
  forkSession(externalSessionId: string, cwd: string, target: { kind: 'latest' } | { kind: 'turn'; turnIndex: number },mayDispatch?:()=>Promise<boolean>): Promise<{ forkedSessionId: string; targetMessageId?: string }>;
}
export interface EngineRecoveryAdapter {
  readonly restartMode: 'resume' | 'interrupt';
}
export interface EngineTerminalAdapter {
  toTurnFact(event: EngineEventEnvelope, context: EngineTerminalFactContext): EngineTurnFact | null;
}
export interface EngineProcessSemanticsAdapter {}
export interface EngineInteractionAdapter {
  normalize(request: EngineInteractionRequest): NormalizedInteraction;
  buildResponse(request: EngineInteractionRequest, command: InteractionResponseCommand): unknown;
}
export interface EngineMaintenanceFacet {}

export type EngineCommandId = 'context.compact';

export interface EngineCommandAdapter {
  readonly commands: readonly EngineCommandId[];
  execute(command: EngineCommandId): Promise<void>;
}
