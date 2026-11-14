interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function getPendingApprovalHiddenKey(userId: string): string {
  return `relay_pending_approval_hidden_v1:${userId}`;
}

export function readHiddenApprovalIds(userId: string, storage: StorageLike | null = browserStorage()): string[] {
  if (!userId || !storage) return [];
  try {
    const raw = storage.getItem(getPendingApprovalHiddenKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; ids?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.ids)) return [];
    return [...new Set(parsed.ids.filter((id): id is string => typeof id === 'string' && Boolean(id)))].sort();
  } catch {
    return [];
  }
}

export function writeHiddenApprovalIds(
  userId: string,
  ids: string[],
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!userId || !storage) return false;
  try {
    storage.setItem(getPendingApprovalHiddenKey(userId), JSON.stringify({
      version: 1,
      ids: [...new Set(ids.filter(Boolean))].sort(),
    }));
    return true;
  } catch {
    return false;
  }
}

export type { StorageLike as PendingApprovalStorage };
