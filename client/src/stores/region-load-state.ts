export type RegionStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RegionLoadState {
  status: RegionStatus;
  generation: number;
  error: string | null;
}

export type MessageCacheSource = 'none' | 'memory' | 'indexeddb' | 'network';

export interface MessageRegionLoadState extends RegionLoadState {
  revision: number | null;
  cacheSource: MessageCacheSource;
  hasMore: boolean;
  nextCursor: { beforeCreatedAt: number; beforeId: string } | null;
  dirty: boolean;
}

export function createRegionLoadState(status: RegionStatus = 'idle'): RegionLoadState {
  return { status, generation: 0, error: null };
}

export function createMessageRegionLoadState(): MessageRegionLoadState {
  return {
    ...createRegionLoadState(),
    revision: null,
    cacheSource: 'none',
    hasMore: false,
    nextCursor: null,
    dirty: false,
  };
}

export function beginRegionLoad<T extends RegionLoadState>(state: T): T {
  return {
    ...state,
    status: 'loading',
    generation: state.generation + 1,
    error: null,
  };
}

export function commitRegionReady<T extends RegionLoadState>(state: T, generation: number): T {
  if (state.generation !== generation) return state;
  return { ...state, status: 'ready', error: null };
}

export function commitRegionError<T extends RegionLoadState>(state: T, generation: number, error: string): T {
  if (state.generation !== generation) return state;
  return { ...state, status: 'error', error };
}

export function isCurrentRegionGeneration(state: RegionLoadState, generation: number): boolean {
  return state.generation === generation;
}
