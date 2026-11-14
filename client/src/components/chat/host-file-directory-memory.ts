export function getHostFileDirectoryKey(chatDraftKey: string): string {
  return `${chatDraftKey}:host-file-directory`;
}

export function readHostFileDirectory(storage: Pick<Storage, 'getItem'>, key: string): string {
  return storage.getItem(key) || '';
}

export function rememberHostFileDirectory(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  directoryPath: string,
): void {
  const concretePath = directoryPath.trim();
  if (concretePath) storage.setItem(key, concretePath);
}
