export const MOBILE_SIDEBAR_SWIPE_EDGE_DEAD_ZONE = 32;
export const MOBILE_SIDEBAR_SWIPE_OPEN_ZONE_END = 96;
export const MOBILE_SIDEBAR_SWIPE_DIRECTION_LOCK_DISTANCE = 12;
export const MOBILE_SIDEBAR_SWIPE_VERTICAL_CANCEL_DISTANCE = 12;
export const MOBILE_SIDEBAR_SWIPE_HORIZONTAL_RATIO = 1.8;
export const MOBILE_SIDEBAR_SWIPE_COMMIT_DISTANCE = 56;
export const MOBILE_SIDEBAR_SWIPE_FAST_DISTANCE = 28;
export const MOBILE_SIDEBAR_SWIPE_COMMIT_VELOCITY = 0.5;

export type MobileSidebarSwipeMode = 'open' | 'close';
export type MobileSidebarSwipeMovement = 'pending' | 'tracking' | 'cancelled';

export function getMobileSidebarTranslateClass(sidebarOpen: boolean, swipeActive: boolean): string {
  if (swipeActive) return '';
  return sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:-translate-x-full';
}

export function isMobileSidebarOpenSwipeStart(startX: number): boolean {
  return startX >= MOBILE_SIDEBAR_SWIPE_EDGE_DEAD_ZONE
    && startX <= MOBILE_SIDEBAR_SWIPE_OPEN_ZONE_END;
}

export function resolveMobileSidebarSwipeMovement(
  mode: MobileSidebarSwipeMode,
  deltaX: number,
  deltaY: number,
): MobileSidebarSwipeMovement {
  const directionalDistance = mode === 'open' ? deltaX : -deltaX;
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);

  if (
    directionalDistance >= MOBILE_SIDEBAR_SWIPE_DIRECTION_LOCK_DISTANCE
    && horizontalDistance > verticalDistance * MOBILE_SIDEBAR_SWIPE_HORIZONTAL_RATIO
  ) return 'tracking';
  if (directionalDistance <= -MOBILE_SIDEBAR_SWIPE_DIRECTION_LOCK_DISTANCE) return 'cancelled';
  if (verticalDistance >= MOBILE_SIDEBAR_SWIPE_VERTICAL_CANCEL_DISTANCE) return 'cancelled';
  return 'pending';
}

export function getMobileSidebarSwipeDistance(mode: MobileSidebarSwipeMode, deltaX: number): number {
  return Math.max(0, mode === 'open' ? deltaX : -deltaX);
}

export function shouldCommitMobileSidebarSwipe(distance: number, elapsedMs: number): boolean {
  if (distance >= MOBILE_SIDEBAR_SWIPE_COMMIT_DISTANCE) return true;
  if (distance < MOBILE_SIDEBAR_SWIPE_FAST_DISTANCE || elapsedMs <= 0) return false;
  return distance / elapsedMs >= MOBILE_SIDEBAR_SWIPE_COMMIT_VELOCITY;
}

export function getMobileSidebarSwipeTranslateX(
  mode: MobileSidebarSwipeMode,
  panelWidth: number,
  distance: number,
): number {
  const boundedDistance = Math.min(Math.max(distance, 0), panelWidth);
  return mode === 'open' ? -panelWidth + boundedDistance : -boundedDistance;
}
