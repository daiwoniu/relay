export type PreviewOperationState = Readonly<Record<string, number>>;

/** A cancelled operation may finish after a newer operation on the same file. */
export function completePreviewOperation(state: PreviewOperationState, tabId: string, generation?: number): PreviewOperationState {
  if (state[tabId] === undefined || (generation !== undefined && state[tabId] !== generation)) return state;
  const next = { ...state };
  delete next[tabId];
  return next;
}

export function currentPreviewOperationTab(
  state: PreviewOperationState,
  tabId: string | null,
  isCurrent: (tabId: string, generation: number) => boolean,
): string | null {
  return tabId && state[tabId] !== undefined && isCurrent(tabId, state[tabId]) ? tabId : null;
}
