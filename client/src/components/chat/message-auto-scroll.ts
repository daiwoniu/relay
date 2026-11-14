import { MESSAGE_BOTTOM_EDGE_EPSILON_PX } from './message-history-window.ts';

interface FollowLatestStateInput {
  followingLatest: boolean;
  previousScrollTop: number;
  scrollTop: number;
  distanceToBottom: number;
  threshold?: number;
  manuallyPaused?: boolean;
}

export function getNextFollowLatestState({
  followingLatest,
  previousScrollTop,
  scrollTop,
  distanceToBottom,
  threshold = MESSAGE_BOTTOM_EDGE_EPSILON_PX,
  manuallyPaused = false,
}: FollowLatestStateInput): boolean {
  if (manuallyPaused) return false;
  if (distanceToBottom <= threshold) return true;
  if (!followingLatest) return false;
  return scrollTop >= previousScrollTop;
}
