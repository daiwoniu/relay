export const SIDEBAR_DEFAULT_WIDTH = 300;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;

const SIDEBAR_WIDTH_STORAGE_KEY = 'relay.sidebar.width.v1';

interface SidebarWidthStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function getBrowserStorage(): SidebarWidthStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function readStoredSidebarWidth(storage = getBrowserStorage()): number {
  if (!storage) return SIDEBAR_DEFAULT_WIDTH;
  try {
    const value = storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    return value === null ? SIDEBAR_DEFAULT_WIDTH : clampSidebarWidth(Number(value));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function storeSidebarWidth(width: number, storage = getBrowserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // 浏览器禁用存储时仍允许当前页面继续调整宽度。
  }
}
