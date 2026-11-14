export function getInitialInteractionPanelExpanded(pending: boolean): boolean {
  return pending;
}

export function shouldAutoCollapseInteractionPanel(wasPending: boolean, pending: boolean): boolean {
  return wasPending && !pending;
}
