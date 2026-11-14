export const TOOL_IDS = ['news', 'calendar', 'weather', 'greeting', 'timestamp', 'json', 'qr', 'diff', 'pomodoro', 'units', 'dates', 'shopping', 'random'] as const;
export type ToolId = typeof TOOL_IDS[number];
export const LOCAL_TOOL_IDS = ['timestamp', 'json', 'qr', 'diff', 'pomodoro', 'units', 'dates', 'shopping', 'random'] as const;
export type LocalToolId = typeof LOCAL_TOOL_IDS[number];
export type LifeToolId = Extract<LocalToolId, 'units' | 'dates' | 'shopping' | 'random'>;
export interface ToolUsage { count: number; lastUsed: number }
export interface ToolsState { pinned: ToolId[]; usage: Partial<Record<ToolId, ToolUsage>> }

export function toolsStorageKey(userId: string | null, deviceId: string): string {
  return `relay:tools:v1:${userId ? `user:${userId}` : `client:${deviceId || 'temporary'}`}`;
}

export function readToolsState(raw: string | null): ToolsState {
  const fallback = { pinned: ['news'] as ToolId[], usage: {} };
  try {
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return fallback;
    const pinned = Array.isArray(value.pinned)
      ? [...new Set<ToolId>(value.pinned.filter((id: unknown): id is ToolId => TOOL_IDS.includes(id as ToolId)))] : fallback.pinned;
    const usage: ToolsState['usage'] = {};
    for (const id of TOOL_IDS) {
      const entry = value.usage?.[id];
      if (Number.isSafeInteger(entry?.count) && entry.count > 0 && Number.isSafeInteger(entry.lastUsed) && entry.lastUsed >= 0) {
        usage[id] = { count: Math.min(entry.count, 1_000_000), lastUsed: entry.lastUsed };
      }
    }
    return { pinned, usage };
  } catch { return fallback; }
}

export function recordToolUse(state: ToolsState, id: ToolId, now = Date.now()): ToolsState {
  return { ...state, usage: { ...state.usage, [id]: { count: Math.min((state.usage[id]?.count ?? 0) + 1, 1_000_000), lastUsed: now } } };
}

export function toggleToolPin(state: ToolsState, id: ToolId): ToolsState {
  return { ...state, pinned: state.pinned.includes(id) ? state.pinned.filter((value) => value !== id) : [...state.pinned, id] };
}

export function frequentTools(state: ToolsState): ToolId[] {
  return TOOL_IDS.filter((id) => (state.usage[id]?.count ?? 0) > 0).sort((a, b) =>
    (state.usage[b]?.count ?? 0) - (state.usage[a]?.count ?? 0)
    || (state.usage[b]?.lastUsed ?? 0) - (state.usage[a]?.lastUsed ?? 0));
}

export function toolOrder(filter: 'all' | 'frequent', usageAtLoad: ToolsState['usage']): ToolId[] {
  return filter === 'all' ? [...TOOL_IDS] : frequentTools({ pinned: [], usage: usageAtLoad });
}
