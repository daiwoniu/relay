import type { ErrorEvent } from '../generated/relay-contracts';

const uncertainCodes = new Set(['STORAGE_UNAVAILABLE', 'OUTCOME_UNKNOWN', 'TIMEOUT', 'OPERATION_EXPIRED']);
const operationCodes = new Set(['STORAGE_UNAVAILABLE', 'FORBIDDEN', 'CONFLICT', 'INVALID_ARGUMENT', 'OVERLOADED', 'NOT_FOUND', 'NOT_SUBMITTED', 'OPERATION_EXPIRED']);

export function getFrontendErrorDisposition(event: Pick<ErrorEvent, 'commandType' | 'code' | 'messageId'>, pendingSend = true): 'send-rejected' | 'send-uncertain' | 'operation' | 'runtime' {
  if (event.commandType && event.commandType !== 'send' || event.code?.startsWith('TURN_CANCEL_') || event.code?.startsWith('FOLLOWUP_')) return 'operation';
  if (event.commandType === 'send' || (event.messageId && pendingSend)) {
    return uncertainCodes.has(event.code || '') ? 'send-uncertain' : 'send-rejected';
  }
  if (operationCodes.has(event.code || '') || event.messageId && !/^(CODEX_|CODEBUDDY_|OPENCODE_|ZCODE_|TURN_)/.test(event.code || '')) return 'operation';
  return 'runtime';
}

export function shouldKeepLocalSendFeedback(input: { localSendPending: boolean; sessionId?: string; streamingSessionId: string | null; isWaiting: boolean }): boolean {
  return input.localSendPending && input.sessionId === input.streamingSessionId && input.isWaiting;
}
