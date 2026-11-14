const restoreActions = new Map<string, () => void>();

export function registerMinimizedPanel(id: string, restore: () => void) {
  restoreActions.set(id, restore);
  return () => { if (restoreActions.get(id) === restore) restoreActions.delete(id); };
}

export function restoreMinimizedPanel(id: string) {
  const restore = restoreActions.get(id);
  restore?.();
  return Boolean(restore);
}
