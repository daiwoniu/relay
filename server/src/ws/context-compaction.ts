export function getContextCompactionIdentity(event: {
  type: string;
  item?: { type?: string; [key: string]: unknown };
  threadId?: string;
  turnId?: string;
}): { threadId: string; turnId: string } | null {
  if (event.type !== 'item_complete' || event.item?.type !== 'contextCompaction') return null;
  if (typeof event.threadId !== 'string' || !event.threadId
    || typeof event.turnId !== 'string' || !event.turnId) return null;
  return { threadId: event.threadId, turnId: event.turnId };
}

export function persistContextCompactionItemSafely(
  sessionId: string,
  event: Parameters<typeof getContextCompactionIdentity>[0],
  increment: (id: string, identity: { threadId: string; turnId: string }) => void,
): void {
  const identity = getContextCompactionIdentity(event);
  if (identity) persistContextCompactionCountSafely(sessionId, identity, increment);
}

export function persistContextCompactionCountSafely(
  sessionId: string,
  details: Record<string, any>,
  increment: (id: string, event: { threadId: string; turnId: string }) => void,
): void {
  const { threadId, turnId } = details;
  if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId) {
    console.error('[Context] 自动整理通知缺少幂等身份，已跳过计数');
    return;
  }
  try {
    increment(sessionId, { threadId, turnId });
  } catch (error) {
    console.error('[Context] 保存自动整理次数失败', error);
  }
}
