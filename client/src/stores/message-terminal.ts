import type { MessageDto } from '../generated/relay-contracts';

// Legacy standalone approvals were saved as empty completed final answers.
// They are audit records, not a signal to settle the active stream.
export function isAssistantTerminalMessage(message: Pick<MessageDto, 'role' | 'phase' | 'content' | 'outcome'>): boolean {
  return message.role === 'assistant'
    && message.phase !== 'interaction'
    && Boolean(message.outcome)
    && (message.outcome !== 'completed' || Boolean(message.content.trim()));
}
