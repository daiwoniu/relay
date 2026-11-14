interface ProcessPanelUiState {
  panelExpanded?: boolean;
  panelSettled?: boolean;
}

export function getInitialProcessPanelCollapsed(
  defaultCollapsed: boolean,
  settled: boolean,
  preserveExpandedOnSettle: boolean,
  ui?: ProcessPanelUiState,
): boolean {
  if (preserveExpandedOnSettle) return false;
  // 实时气泡完成后会重新挂载，终态转换必须从共享 UI 状态恢复。
  if (ui?.panelSettled === false && settled) return true;
  return ui?.panelExpanded === undefined ? defaultCollapsed : !ui.panelExpanded;
}

export function shouldAutoCollapseProcessPanel(
  wasSettled: boolean,
  isSettled: boolean,
): boolean {
  return !wasSettled && isSettled;
}

export function getSearchPreservedExpandedState(
  currentExpanded: boolean,
  defaultExpanded: boolean,
  wasSearchTarget: boolean,
  isSearchTarget: boolean,
): boolean {
  if (isSearchTarget) return true;
  if (wasSearchTarget) return currentExpanded;
  return defaultExpanded;
}

interface ProcessItemState {
  type: string;
  status: string;
}

export function hasPendingInteraction(steps: ProcessItemState[]): boolean {
  return steps.some((step) => step.type === 'interaction' && step.status === 'in_progress');
}
