const SCROLL_END_TOLERANCE_PX = 1;

export function hasSettingsNavigationForwardScroll({
  scrollLeft,
  scrollWidth,
  clientWidth,
}: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): boolean {
  return scrollWidth - clientWidth - scrollLeft > SCROLL_END_TOLERANCE_PX;
}
