export const MOBILE_KEYBOARD_HEIGHT_THRESHOLD = 120;

export function retainExpandedViewportHeight(previousHeight: number, currentHeight: number): number {
  if (!Number.isFinite(currentHeight) || currentHeight <= 0) return previousHeight;
  if (!Number.isFinite(previousHeight) || previousHeight <= 0) return currentHeight;
  return Math.max(previousHeight, currentHeight);
}

export function shouldKeepComposerBehindSearchKeyboard({
  mobile,
  searchInputFocused,
  expandedViewportHeight,
  currentViewportHeight,
}: {
  mobile: boolean;
  searchInputFocused: boolean;
  expandedViewportHeight: number;
  currentViewportHeight: number;
}): boolean {
  if (!mobile || !searchInputFocused) return false;
  if (!Number.isFinite(expandedViewportHeight) || !Number.isFinite(currentViewportHeight)) return false;
  return expandedViewportHeight - currentViewportHeight >= MOBILE_KEYBOARD_HEIGHT_THRESHOLD;
}
