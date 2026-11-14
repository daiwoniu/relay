import type { MessageDto } from '../../generated/relay-contracts';

export function getFinalCompletedAssistantIndex(messages: MessageDto[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.outcome === 'completed') return index;
  }
  return -1;
}

export function getSelectableMessageIds(messages: MessageDto[]): Set<string> {
  const cutoff = getFinalCompletedAssistantIndex(messages);
  if (cutoff < 0) return new Set();
  return new Set(messages.slice(0, cutoff + 1)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => message.id));
}

export function normalizeSelectedMessageIds(messages: MessageDto[], selectedIds: Iterable<string>): string[] {
  const selected = new Set(selectedIds);
  const selectable = getSelectableMessageIds(messages);
  return messages
    .filter((message) => selected.has(message.id) && selectable.has(message.id))
    .map((message) => message.id);
}

export function canCreateSelectionShare(messages: MessageDto[], selectedIds: Iterable<string>): boolean {
  return normalizeSelectedMessageIds(messages, selectedIds).length > 0;
}

export function shouldDimShareMessage(selectionMode: boolean, selectable: boolean): boolean {
  return selectionMode && !selectable;
}
