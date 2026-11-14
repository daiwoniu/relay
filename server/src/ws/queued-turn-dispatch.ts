import type { Message } from '../db/query-types.js';
import type { QueueClaim, QueueClaimDispatcher } from '../engine/concurrency/repository.js';
import { parseMessageMetadata } from '../message-metadata.js';
import { composeMessageCodexInput } from '../messages/message-attachments.js';

export interface QueuedTurnPayload {
  claim: QueueClaim;
  message: Message;
  content: string;
}

export interface QueuedTurnDispatchPorts {
  loadUserMessage(sessionId: string, messageId: string): Message | null;
  startTurn(payload: QueuedTurnPayload): Promise<void> | void;
  failTurn(claim: QueueClaim, error: unknown): Promise<void> | void;
}

export class QueuedTurnDispatcher implements QueueClaimDispatcher {
  private readonly starts = new Map<string, Promise<void>>();

  constructor(private readonly ports: QueuedTurnDispatchPorts) {}

  start(claim: QueueClaim): Promise<void> {
    const token = claim.lease.leaseToken;
    const existing = this.starts.get(token);
    if (existing) return existing;
    const started = Promise.resolve().then(async () => {
      if (claim.queue.claimToken !== token) throw new Error('queue claim token 与 lease 不一致');
      const message = this.ports.loadUserMessage(claim.queue.sessionId, claim.queue.userMessageId);
      if (!message || message.role !== 'user' || message.turn_id !== claim.queue.attemptId) {
        throw new Error('claimed 回合缺少匹配的持久化用户消息');
      }
      const attachments = parseMessageMetadata(message.metadata).attachments || [];
      await this.ports.startTurn({ claim, message, content: composeMessageCodexInput(message.content, attachments) });
    });
    const tracked = started.finally(() => {
      if (this.starts.get(token) === tracked) this.starts.delete(token);
    });
    this.starts.set(token, tracked);
    return tracked;
  }

  fail(claim: QueueClaim, error: unknown): Promise<void> | void {
    return this.ports.failTurn(claim, error);
  }
}
