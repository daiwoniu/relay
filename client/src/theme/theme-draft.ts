export type RemoteThemeDraftAction = 'unchanged' | 'replace' | 'conflict';

export function getRemoteThemeDraftAction(
  baseUpdatedAt: number,
  dirty: boolean,
  remoteUpdatedAt: number,
): RemoteThemeDraftAction {
  if (remoteUpdatedAt === baseUpdatedAt) return 'unchanged';
  return dirty ? 'conflict' : 'replace';
}
