import { create } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EngineId, EngineModelCatalogDto, SessionDto } from '../generated/relay-contracts.ts';
import { getEngineModels } from '../api/engine-models.ts';

export type EngineModelsLoadStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';
export interface EngineModelsEntry {
  status: EngineModelsLoadStatus;
  catalog?: EngineModelCatalogDto;
  error?: string;
}
export interface EngineModelDraft {
  engineId: EngineId;
  modelId: string | null;
  reasoningEffort: string | null;
  serviceTier?: string | null;
}
export interface EngineModelsState {
  byEngine: Partial<Record<EngineId, EngineModelsEntry>>;
  draftBySession: Record<string, EngineModelDraft>;
  load(engineId: EngineId, options?: { refresh?: boolean }): Promise<EngineModelCatalogDto>;
  invalidate(engineId: EngineId): void;
  setDraft(sessionId: string, engineId: EngineId, preferences: Omit<EngineModelDraft, 'engineId'>): void;
  clearDraft(sessionId: string): void;
  switchDraftEngine(sessionId: string, engineId: EngineId): void;
}

type FetchCatalog = (engineId: EngineId, refresh: boolean) => Promise<EngineModelCatalogDto>;

function stateCreator(
  set: StoreApi<EngineModelsState>['setState'],
  get: StoreApi<EngineModelsState>['getState'],
  fetchCatalog: FetchCatalog,
): EngineModelsState {
  const inFlight = new Map<EngineId, Promise<EngineModelCatalogDto>>();
  return {
    byEngine: {},
    draftBySession: {},
    load: (engineId, options = {}) => {
      const currentRequest = inFlight.get(engineId);
      if (currentRequest) return currentRequest;
      const currentCatalog = get().byEngine[engineId];
      if (!options.refresh && currentCatalog?.status === 'ready' && currentCatalog.catalog) {
        return Promise.resolve(currentCatalog.catalog);
      }
      set((state) => ({
        byEngine: {
          ...state.byEngine,
          [engineId]: { ...state.byEngine[engineId], status: 'loading', error: undefined },
        },
      }));
      const request = (async () => {
        try {
          const catalog = await fetchCatalog(engineId, options.refresh === true);
          set((state) => ({
            byEngine: {
              ...state.byEngine,
              [engineId]: { status: catalog.stale ? 'stale' : 'ready', catalog },
            },
          }));
          return catalog;
        } catch (error) {
          set((state) => {
            const previous = state.byEngine[engineId];
            return {
              byEngine: {
                ...state.byEngine,
                [engineId]: {
                  ...previous,
                  status: previous?.catalog ? 'stale' : 'error',
                  error: error instanceof Error ? error.message : '模型目录加载失败',
                },
              },
            };
          });
          throw error;
        } finally {
          inFlight.delete(engineId);
        }
      })();
      inFlight.set(engineId, request);
      return request;
    },
    invalidate: (engineId) => set((state) => {
      if (!state.byEngine[engineId]) return state;
      const byEngine = { ...state.byEngine };
      delete byEngine[engineId];
      return { byEngine };
    }),
    setDraft: (sessionId, engineId, preferences) => set((state) => ({
      draftBySession: { ...state.draftBySession, [sessionId]: { engineId, ...preferences } },
    })),
    clearDraft: (sessionId) => set((state) => {
      if (!state.draftBySession[sessionId]) return state;
      const draftBySession = { ...state.draftBySession };
      delete draftBySession[sessionId];
      return { draftBySession };
    }),
    switchDraftEngine: (sessionId, engineId) => set((state) => {
      const current = state.draftBySession[sessionId];
      if (!current || current.engineId === engineId) return state;
      const next = { ...state.draftBySession };
      delete next[sessionId];
      return { draftBySession: next };
    }),
  };
}

export function mergeSessionByPreferencesRevision<T extends Pick<SessionDto, 'engine_preferences'>>(
  current: T,
  incoming: T,
): T {
  if (!incoming.engine_preferences || !current.engine_preferences) return incoming;
  return incoming.engine_preferences.revision < current.engine_preferences.revision
    ? { ...incoming, engine_preferences: current.engine_preferences }
    : incoming;
}

export function createEngineModelsStore(
  fetchCatalog: FetchCatalog = (engineId, refresh) => getEngineModels(engineId, { refresh }),
): StoreApi<EngineModelsState> {
  return createStore<EngineModelsState>((set, get) => stateCreator(set, get, fetchCatalog));
}

export const useEngineModelsStore = create<EngineModelsState>((set, get) => stateCreator(
  set,
  get,
  (engineId, refresh) => getEngineModels(engineId, { refresh }),
));
