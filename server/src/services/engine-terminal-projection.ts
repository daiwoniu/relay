import type {
  EngineTerminalProjectionRecord,
  EngineTerminalProjectionResult,
  NewMessageRecord,
} from '../db/queries.js';
import type { SessionStatus } from '../contracts/index.js';
import type { EngineTerminalDecision } from '../engine/turn-facts.js';
import {
  serializeTerminalMessageMetadata,
  type MessageMetadata,
} from '../message-metadata.js';
import { sessionService } from './sessions.js';

export interface EngineTerminalProjectionSnapshot {
  messageId: string;
  turnId: string;
  content: string;
  items?: string | null;
  duration?: number | null;
  metadata?: Omit<MessageMetadata, 'outcome'>;
}

export interface EngineTerminalProjectionInput {
  decision: EngineTerminalDecision;
  snapshot: EngineTerminalProjectionSnapshot;
  sessionStatus?: Extract<SessionStatus, 'idle' | 'completed' | 'failed' | 'interrupted' | 'stopped'>;
}

interface EngineTerminalProjectionPort {
  project(input: EngineTerminalProjectionRecord): EngineTerminalProjectionResult;
}

export interface EngineTerminalProjectionPublisher {
  publish(result: EngineTerminalProjectionResult): void;
}

function buildCompatibilityMessage(input: EngineTerminalProjectionInput): NewMessageRecord {
  const { decision, snapshot } = input;
  if (!snapshot.messageId || !snapshot.turnId) throw new Error('终态投影消息标识不能为空');
  if (decision.externalTurnId && decision.externalTurnId !== snapshot.turnId) {
    throw new Error('终态投影消息 turn 与决定不匹配');
  }
  if (decision.outcome === 'completed' && !snapshot.content.trim()) {
    throw new Error('completed 终态必须包含非空正文');
  }

  const metadata = snapshot.metadata || {};
  const errorCode = decision.outcome === 'failed' || decision.outcome === 'interrupted'
    ? metadata.errorCode || decision.reasonCode
    : metadata.errorCode;
  return {
    id: snapshot.messageId,
    session_id: decision.sessionId,
    turn_id: snapshot.turnId,
    role: 'assistant',
    content: snapshot.content,
    phase: decision.outcome === 'completed'
      ? 'final_answer'
      : decision.outcome === 'stopped' ? null : 'error',
    items: snapshot.items ?? null,
    metadata: serializeTerminalMessageMetadata(decision.outcome, {
      ...metadata,
      ...(errorCode ? { errorCode } : {}),
    }),
    duration: snapshot.duration ?? null,
    stopped: decision.outcome === 'stopped' ? 1 : 0,
  };
}

const defaultProjectionPort: EngineTerminalProjectionPort = {
  project: (input) => sessionService.projectEngineTerminal(input),
};
const noProjectionPublisher: EngineTerminalProjectionPublisher = { publish: () => undefined };

export function publishEngineTerminalProjectionSafely(
  result: EngineTerminalProjectionResult,
  publish: EngineTerminalProjectionPublisher['publish'],
  diagnostic: (message: string) => void = (message) => console.warn(`[Relay] ${message}`),
): void {
  if (!result.projected) return;
  try {
    publish(result);
  } catch {
    try {
      diagnostic('ENGINE_TERMINAL_PROJECTION_PUBLISH_FAILED');
    } catch {
      // Diagnostics are best-effort and must not affect committed state.
    }
    // A later sync_state can recover a committed projection when live publication fails.
  }
}

export function createEngineTerminalProjectionService({
  project = defaultProjectionPort.project,
  publish = noProjectionPublisher.publish,
  diagnostic = (message: string) => console.warn(`[Relay] ${message}`),
}: {
  project?: EngineTerminalProjectionPort['project'];
  publish?: EngineTerminalProjectionPublisher['publish'];
  diagnostic?: (message: string) => void;
} = {}) {
  return {
    project(input: EngineTerminalProjectionInput): EngineTerminalProjectionResult {
      const result = project({
        decision: input.decision,
        message: buildCompatibilityMessage(input),
        sessionStatus: input.sessionStatus ?? input.decision.outcome,
      });
      publishEngineTerminalProjectionSafely(result, publish, diagnostic);
      return result;
    },
  };
}

export const engineTerminalProjectionService = createEngineTerminalProjectionService();
