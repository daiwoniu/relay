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
