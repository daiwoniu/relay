export function shouldFlushDeltaBatch(
  pendingContent: string,
  pendingPhase: string | undefined,
  nextPhase: string | undefined,
  pendingItemId?: string,
  nextItemId?: string,
): boolean {
  return Boolean(pendingContent) && (pendingPhase !== nextPhase || pendingItemId !== nextItemId);
}
