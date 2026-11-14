export const RIGHT_PANEL_DEFAULT_WIDTH = 420;
export const RIGHT_PANEL_MIN_WIDTH = 280;
export const RIGHT_PANEL_MAX_WIDTH = 900;

const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'relay.right-panel.width.v1';

interface RightPanelWidthStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function getBrowserStorage(): RightPanelWidthStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function clampRightPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return RIGHT_PANEL_DEFAULT_WIDTH;
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)));
}

export function getRightPanelWidthFromKey(width: number, key: string): number | null {
  if (key === 'ArrowLeft') return clampRightPanelWidth(width + 10);
  if (key === 'ArrowRight') return clampRightPanelWidth(width - 10);
  if (key === 'Home') return RIGHT_PANEL_MIN_WIDTH;
  if (key === 'End') return RIGHT_PANEL_MAX_WIDTH;
  return null;
}

export function readStoredRightPanelWidth(storage = getBrowserStorage()): number {
  if (!storage) return RIGHT_PANEL_DEFAULT_WIDTH;
  try {
    const value = storage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
    return value === null ? RIGHT_PANEL_DEFAULT_WIDTH : clampRightPanelWidth(Number(value));
  } catch {
    return RIGHT_PANEL_DEFAULT_WIDTH;
  }
}

export function storeRightPanelWidth(width: number, storage = getBrowserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(clampRightPanelWidth(width)));
  } catch {
    // 浏览器禁用存储时仍允许当前页面继续调整宽度。
  }
}
