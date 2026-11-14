const VIEWPORT_HEIGHT_RATIO = 0.6;
const MIN_HEIGHT_THRESHOLD = 280;
const MAX_HEIGHT_THRESHOLD = 480;

export function getProcessPanelBottomCollapseThreshold(viewportHeight: number): number {
  const normalizedViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight
    : 800;
  return Math.min(
    MAX_HEIGHT_THRESHOLD,
    Math.max(MIN_HEIGHT_THRESHOLD, normalizedViewportHeight * VIEWPORT_HEIGHT_RATIO),
  );
}

export function shouldShowProcessPanelBottomCollapse(
  contentHeight: number,
  viewportHeight: number,
): boolean {
  return Number.isFinite(contentHeight)
    && contentHeight > getProcessPanelBottomCollapseThreshold(viewportHeight);
}
