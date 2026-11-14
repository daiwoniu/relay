export type WorkbenchTheme = 'daylight' | 'peach' | 'mint' | 'crystal' | 'glass';

export const WORKBENCH_THEME_STORAGE_KEY = 'relay:workbench-theme';
export const WORKBENCH_THEME_OPTIONS: ReadonlyArray<{ id: WorkbenchTheme; label: string; note: string }> = [
  { id: 'daylight', label: '清爽浅色', note: '雾白 · 浅蓝' },
  { id: 'peach', label: '奶油杏桃', note: '奶油白 · 蜜桃' },
  { id: 'mint', label: '云朵薄荷', note: '米白 · 薄荷绿' },
  { id: 'crystal', label: '冰晶蓝', note: '冰蓝 · 水晶切面' },
  { id: 'glass', label: '柔光玻璃', note: '淡紫 · 磨砂玻璃' },
];

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function loadWorkbenchTheme(storage: ThemeStorage | null): WorkbenchTheme {
  try {
    const saved = storage?.getItem(WORKBENCH_THEME_STORAGE_KEY);
    return WORKBENCH_THEME_OPTIONS.find((option) => option.id === saved)?.id ?? 'daylight';
  } catch {
    return 'daylight';
  }
}

export function saveWorkbenchTheme(storage: ThemeStorage | null, theme: WorkbenchTheme): void {
  try {
    storage?.setItem(WORKBENCH_THEME_STORAGE_KEY, theme);
  } catch {
    // Private browsing and restricted storage must not prevent theme changes.
  }
}
