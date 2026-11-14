import type { ProcessTimelineEntry } from '../process-timeline.js';
import type { EngineId } from './types.js';
import type { HostContextDelivery } from './host-context.js';
import type { EngineDescriptor } from './catalog.js';
import type { EngineDiagnostic } from './diagnostics.js';
import type { EngineCapacityObservation } from './diagnostics.js';
import type { EngineEventEnvelope } from './events.js';
import type { EnginePerformanceMilestone } from './performance-observability.js';
import type {
  EngineAvailabilityAdapter,
  EngineCommandAdapter,
  EngineConcurrencyAdapter,
  EngineDiagnosticAdapter,
  EngineHealthAdapter,
  EngineInteractionAdapter,
  EngineMaintenanceFacet,
  EngineModelAdapter,
  EngineProcessSemanticsAdapter,
  EngineProtocolAdapter,
  EngineRecoveryAdapter,
  EngineRuntimeAdapter,
  EngineSessionAdapter,
  EngineTerminalAdapter,
} from './facets.js';

export type EngineTurnItem = {
  id: string;
  type: string;
  status: string;
  [key: string]: unknown;
};

export type EngineEvent =
  | { type: 'capacity_observation'; observation: EngineCapacityObservation }
  | { type: 'request_forwarded' }
  | { type: 'delta'; itemId: string; content: string; phase?: string }
  | { type: 'item_start'; item: EngineTurnItem }
  | { type: 'item_complete'; item: EngineTurnItem; threadId?: string; turnId?: string }
  | { type: 'turn_start'; turnId: string }
  | { type: 'turn_complete'; turnId: string }
  | { type: 'message_complete'; turnId: string; content: string; processContent?: string; finalAnswerItemId?: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null }
  | { type: 'error'; diagnostic: EngineDiagnostic }
  | { type: 'model_info'; model: string; platformOs?: string; modelProvider?: string; reasoningEffort?: string }
  | { type: 'token_usage'; usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number; modelContextWindow: number | null } }
  | {
      type: 'recovery_snapshot';
      turnId: string;
      status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
      content: string;
      processContent?: string;
      finalAnswerItemId?: string;
      processTimeline?: ProcessTimelineEntry[];
      items: EngineTurnItem[];
      waitingOnInteraction: boolean;
      durationMs?: number | null;
      error?: { message: string; code: string } | null;
    }
  | { type: 'server_request'; requestId: string | number; method: string; params: Record<string, any> }
  | { type: 'server_request_resolved'; requestId: string | number }
  | {
      type: 'system_notice';
      noticeType: 'warning' | 'guardian_warning' | 'config_warning' | 'deprecation' | 'model_rerouted' | 'context_compaction';
      title: string;
      message?: string;
      details?: Record<string, any>;
      contextCompaction?: { threadId: string; turnId: string };
    };

export interface EngineCapabilities {
  conversations: boolean;
  streaming: boolean;
  processItems: boolean;
  cancellation: boolean;
  interactions: boolean;
  tokenUsage: boolean;
  archive: boolean;
}

export interface EngineAvailability {
  available: boolean;
  code: string;
  message?: string;
}

export interface EngineTurnOptions {
  preferences: {
    modelId: string | null;
    reasoningEffort: string | null;
    serviceTier?: string | null;
  };
}

export interface EngineConnection {
  send(content: string, options?: EngineTurnOptions): void;
  steer?(input: { content: string; messageId: string; expectedTurnId: string }): Promise<'accepted' | 'turn_changed' | 'unsupported'>;
  cancel(): Promise<void>;
  respondToInteraction(requestId: string | number, result: unknown): void;
  close(): void;
}

export interface EngineConnectionOptions {
  sessionId: string;
  cwd?: string;
  externalSessionId: string | null;
  hostContext?: HostContextDelivery;
  /** 仅在具体发送请求获得成功应答时回报，通知流不得冒充请求应答。 */
  onInputAccepted?(turnId: string, content: string): void;
  /** Providers await asynchronous persistence; legacy synchronous return values are ignored. */
  onSessionReady(id: string): unknown;
  onEvent(event: EngineEventEnvelope): void;
  onClosed(): void;
  onPerformanceMilestone?(milestone: EnginePerformanceMilestone): void;
  recoverTurnId?: string | null;
  recoverStartedAt?: number | null;
  initialTurnOptions?: EngineTurnOptions;
}

export interface EngineAdapter {
  readonly id: EngineId;
  readonly descriptor: EngineDescriptor;
  readonly runtime: EngineRuntimeAdapter;
  readonly availability: EngineAvailabilityAdapter;
  readonly diagnostics: EngineDiagnosticAdapter;
  readonly health: EngineHealthAdapter;
  readonly concurrency?: EngineConcurrencyAdapter;
  readonly protocol?: EngineProtocolAdapter;
  readonly sessions?: EngineSessionAdapter;
  readonly recovery?: EngineRecoveryAdapter;
  readonly terminal?: EngineTerminalAdapter;
  readonly process?: EngineProcessSemanticsAdapter;
  readonly commands?: EngineCommandAdapter;
  readonly interactions?: EngineInteractionAdapter;
  readonly maintenance?: EngineMaintenanceFacet;
  readonly models?: EngineModelAdapter;
}
