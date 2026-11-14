type RevocationListener = (tokenHash: string) => void;
type UserAccessRevocationListener = (userId: string) => void;

const listeners = new Set<RevocationListener>();
const userAccessListeners = new Set<UserAccessRevocationListener>();

export function onAuthSessionRevoked(listener: RevocationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyAuthSessionRevoked(tokenHash: string): void {
  for (const listener of listeners) listener(tokenHash);
}

export function onUserAccessRevoked(listener: UserAccessRevocationListener): () => void {
  userAccessListeners.add(listener);
  return () => userAccessListeners.delete(listener);
}

export function notifyUserAccessRevoked(userId: string): void {
  for (const listener of userAccessListeners) listener(userId);
}
