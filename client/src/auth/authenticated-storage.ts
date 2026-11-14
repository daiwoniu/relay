const USER_STORAGE_KEYS = new Set(['relay_chat_location', 'relay.local-notes.v1']);
const USER_STORAGE_PREFIXES = ['relay:chat-draft:', 'relay.project-engine.v1:', 'relay_pending_approval_hidden_v1:', 'relay:engine-maintenance:'];

export function clearAuthenticatedLocalStorage(storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
  if (!storage) return;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key));
  for (const key of keys) {
    if (USER_STORAGE_KEYS.has(key) || USER_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) storage.removeItem(key);
  }
}
