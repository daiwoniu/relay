interface DraftLocation {
  sessionId: string | null | undefined;
  pendingProjectPath: string | null | undefined;
  currentProjectId: string | null | undefined;
}

export function getChatDraftKey(location: DraftLocation): string {
  const scope = location.sessionId
    ? `session:${location.sessionId}`
    : `new:${location.pendingProjectPath || location.currentProjectId || 'none'}`;
  return `relay:chat-draft:${encodeURIComponent(scope)}`;
}

export function readChatDraft(storage: Pick<Storage, 'getItem'>, key: string): string {
  return storage.getItem(key) || '';
}

export function writeChatDraft(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string,
  value: string,
): void {
  if (value) storage.setItem(key, value);
  else storage.removeItem(key);
}

export function clearChatDraft(storage: Pick<Storage, 'removeItem'>, key: string): void {
  storage.removeItem(key);
}
