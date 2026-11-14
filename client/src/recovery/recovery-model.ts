export type RecoveryAction = 'restart_backend' | 'reload_browser' | 'restart_frontend' | 'retry_connection';

export function getRecoveryAction(input: {
  client: number;
  server: number;
  refreshed?: boolean;
}): RecoveryAction {
  if (input.client > input.server) return 'restart_backend';
  if (input.client < input.server) return input.refreshed ? 'restart_frontend' : 'reload_browser';
  return 'retry_connection';
}

export function getRecoveryRefreshKey(clientVersion: number, serverVersion: number): string {
  return `relay:protocol-refresh:${clientVersion}:${serverVersion}`;
}

export function hasRefreshedForMismatch(
  storage: Pick<Storage, 'getItem'>,
  clientVersion: number,
  serverVersion: number,
): boolean {
  return storage.getItem(getRecoveryRefreshKey(clientVersion, serverVersion)) === '1';
}

export function markMismatchRefreshed(
  storage: Pick<Storage, 'setItem'>,
  clientVersion: number,
  serverVersion: number,
): void {
  storage.setItem(getRecoveryRefreshKey(clientVersion, serverVersion), '1');
}
