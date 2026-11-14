export const MESSAGE_RENDER_BATCH_SIZE = 30;
export const MESSAGE_HISTORY_LOAD_THRESHOLD_PX = 160;
export const MESSAGE_AUTO_SCROLL_THRESHOLD_PX = 64;
export const MESSAGE_BOTTOM_EDGE_EPSILON_PX = 1;

export function getInitialVisibleMessageStart(
  messageCount: number,
  batchSize = MESSAGE_RENDER_BATCH_SIZE,
): number {
  return Math.max(0, messageCount - batchSize);
}

export function getPreviousVisibleMessageStart(
  currentStart: number,
  batchSize = MESSAGE_RENDER_BATCH_SIZE,
): number {
  return Math.max(0, currentStart - batchSize);
}

export function getPrependedScrollTop(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
): number {
  return previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight);
}

export function shouldResetOlderMessageAvailability(
  previousMessageCount: number,
  nextMessageCount: number,
  hasOlderMessages: boolean,
): boolean {
  return hasOlderMessages && nextMessageCount < previousMessageCount;
}

export function shouldPreserveLocatedMessageWindow(
  previousSearchTargetMessageId: string | null,
  searchTargetMessageId: string | null,
): boolean {
  return Boolean(previousSearchTargetMessageId && !searchTargetMessageId);
}

export function shouldKeepLatestMessageVisibleAfterResize(
  scrollTop: number,
  scrollHeight: number,
  previousClientHeight: number,
  nextClientHeight: number,
  threshold = MESSAGE_BOTTOM_EDGE_EPSILON_PX,
): boolean {
  if (previousClientHeight === nextClientHeight) return false;

  const previousDistanceToBottom = scrollHeight - scrollTop - previousClientHeight;
  const nextDistanceToBottom = scrollHeight - scrollTop - nextClientHeight;
  return previousDistanceToBottom <= threshold || nextDistanceToBottom <= threshold;
}
