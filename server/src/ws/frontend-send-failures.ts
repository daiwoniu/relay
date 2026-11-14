import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { serializeMessageMetadata } from '../message-metadata.js';
import type { Message, NewMessageRecord } from '../db/queries.js';
import type { ClientDiagnosticsDto, MessageOriginDto } from '../contracts/index.js';

export interface RejectedSendInput {
  sessionId: string;
  messageId?: string;
  workspaceTaskId?: string;
  content: string;
  attachmentNames: string[];
  message: string;
  code: string;
  origin?: MessageOriginDto;
  clientDiagnostics?: ClientDiagnosticsDto;
}

export function buildFailedSendUserContent(content: string, attachmentNames: string[]): string {
  const trimmed = content.trim();
  const safeAttachmentNames = attachmentNames
    .map((name) => path.win32.basename(path.posix.basename(name)).replace(/[\r\n]/g, ' ').trim())
    .filter(Boolean);
  if (safeAttachmentNames.length === 0) return trimmed;
  const attachmentSummary = `发送附件：${safeAttachmentNames.join('、')}`;
  return trimmed ? `${trimmed}\n\n${attachmentSummary}` : attachmentSummary;
}

export function buildFailedSendMessages(input: RejectedSendInput, existingUserMessage?: Message): NewMessageRecord[] {
  const turnId = existingUserMessage?.turn_id || uuid();
  const assistantMessage: NewMessageRecord = {
    id: uuid(),
    session_id: input.sessionId,
    turn_id: turnId,
    role: 'assistant',
    content: '',
    phase: 'error',
    items: null,
    metadata: serializeMessageMetadata({
      executionStage: 'accepted',
      outcome: 'failed',
      errorCode: input.code,
      errorMessage: input.message,
    }),
    duration: 0,
    stopped: 0,
  };
  if (existingUserMessage) return [assistantMessage];
  return [
    {
      id: input.messageId || uuid(),
      session_id: input.sessionId,
      turn_id: turnId,
      role: 'user',
      content: buildFailedSendUserContent(input.content, input.attachmentNames),
      phase: null,
      items: null,
      metadata: serializeMessageMetadata({ origin: input.origin, clientDiagnostics: input.clientDiagnostics }),
      duration: null,
      stopped: 0,
    },
    assistantMessage,
  ];
}
