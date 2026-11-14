import type { Message } from '../../stores/chat.ts';

/** Only settled, content-free audit records may be folded or attached to a reply. */
export function isHistoricalOperationRecord(message: Message): boolean {
  if (message.role !== 'assistant' || message.content.trim() || message.stopped || message.isError
    || message.errorCode || (message.outcome && message.outcome !== 'completed')
    || !['interaction', 'final_answer'].includes(message.phase ?? '')
    || message.processContent?.trim() || message.processTimeline?.some((entry) => entry.type === 'narrative')
    || message.asyncQuestionIds?.length || message.changedFiles?.length || message.changedFileCount || message.changedFilesIncomplete) return false;
  if (message.items) return message.items.length > 0
    && message.items.every((item) => item.type === 'interaction' && item.status === 'completed');
  return message.historicalOperationRecord === true && message.hasDetails === true && (message.processItemCount ?? 0) > 0
    && (message.processNarrativeCount ?? 0) === 0;
}

/** A display-only association within the rendered window; never infer a turn from timestamps. */
export function groupHistoricalOperationRecords(messages: Message[], preserveRows = false) {
  const nestedIds = new Set<string>();
  const byReply = new Map<string, Message[]>();
  if (preserveRows) return { nestedIds, byReply };
  const replies = new Map<string, Message[]>();
  const key = (message: Message) => JSON.stringify([message.session_id, message.turn_id]);
  for (const message of messages) {
    if (!message.turn_id || message.role !== 'assistant' || message.phase !== 'final_answer'
      || !message.content.trim() || message.outcome !== 'completed' || message.isError || message.stopped) continue;
    const group = replies.get(key(message)) ?? [];
    group.push(message); replies.set(key(message), group);
  }
  for (const message of messages) {
    if (!message.turn_id || !isHistoricalOperationRecord(message)) continue;
    const targets = replies.get(key(message));
    if (targets?.length !== 1) continue;
    const target = targets[0];
    const records = byReply.get(target.id) ?? [];
    records.push(message); byReply.set(target.id, records); nestedIds.add(message.id);
  }
  return { nestedIds, byReply };
}
