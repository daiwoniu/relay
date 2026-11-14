export type OverlayKind = 'tooltip' | 'hover-card' | 'popover' | 'context-menu' | 'dialog' | 'dragging';

const OVERLAY_PRIORITY: Record<OverlayKind, number> = {
  tooltip: 1,
  'hover-card': 2,
  popover: 3,
  'context-menu': 3,
  dialog: 4,
  dragging: 5,
};

export function canReplaceOverlay(current: OverlayKind | null, next: OverlayKind) {
  if (current === 'hover-card' && next === 'tooltip') return true;
  return current === null || OVERLAY_PRIORITY[next] >= OVERLAY_PRIORITY[current];
}
