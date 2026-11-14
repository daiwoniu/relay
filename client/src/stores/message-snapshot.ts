interface MessageSnapshotItem {
  id: string;
  created_at: number;
}

function compareMessageOrder(left: MessageSnapshotItem, right: MessageSnapshotItem): number {
  if (left.created_at !== right.created_at) return left.created_at - right.created_at;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function mergeMessagesById<T extends MessageSnapshotItem>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = merged.get(message.id);
    merged.set(message.id, existing ? { ...existing, ...message } : message);
  }
  return [...merged.values()].sort(compareMessageOrder);
}

export function isCurrentMessageRefresh(
  requestedSessionId: string,
  activeSessionId: string | null,
  requestGeneration: number,
  latestGeneration: number,
): boolean {
  return requestedSessionId === activeSessionId && requestGeneration === latestGeneration;
}

export type MessageRevisionDisposition = 'initial' | 'continuous' | 'duplicate' | 'gap' | 'stale';

export function getMessageRevisionDisposition(
  currentRevision: number | null,
  incomingRevision: number,
): MessageRevisionDisposition {
  if (currentRevision === null) return 'initial';
  if (incomingRevision === currentRevision + 1) return 'continuous';
  if (incomingRevision === currentRevision) return 'duplicate';
  return incomingRevision > currentRevision + 1 ? 'gap' : 'stale';
}
