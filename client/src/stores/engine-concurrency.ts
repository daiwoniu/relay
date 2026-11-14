import { create } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EngineConcurrencyDto, TurnQueueSnapshotDto } from '../generated/relay-contracts.ts';

export interface EngineConcurrencyState {
  concurrencyByResourceKey: Record<string, EngineConcurrencyDto>;
  queueBySessionId: Record<string, TurnQueueSnapshotDto>;
  savingResourceKeys: string[];
  replaceConcurrencySnapshot(items: EngineConcurrencyDto[]): void;
  upsertConcurrency(item: EngineConcurrencyDto): void;
  applyQueueSnapshot(sessionId: string, queue: TurnQueueSnapshotDto | null, authoritative?: boolean): void;
  clearQueue(sessionId: string, queueId?: string): void;
  setSaving(resourceKey: string, saving: boolean): void;
}

function stateCreator(set: StoreApi<EngineConcurrencyState>['setState']): EngineConcurrencyState {
  return {
    concurrencyByResourceKey: {},
    queueBySessionId: {},
    savingResourceKeys: [],
    replaceConcurrencySnapshot: (items) => set({
      concurrencyByResourceKey: Object.fromEntries(items.map((item) => [item.resourceKey, item])),
    }),
    upsertConcurrency: (item) => set((state) => ({
      concurrencyByResourceKey: { ...state.concurrencyByResourceKey, [item.resourceKey]: item },
    })),
    applyQueueSnapshot: (sessionId, queue, authoritative = false) => set((state) => {
      const current = state.queueBySessionId[sessionId];
      if (!queue) {
        if (!current) return state;
        const next = { ...state.queueBySessionId };
        delete next[sessionId];
        return { queueBySessionId: next };
      }
      if (queue.sessionId !== sessionId) return state;
      if (!authoritative && current && (
        queue.createdAt < current.createdAt
        || (queue.createdAt === current.createdAt && queue.queueId !== current.queueId)
      )) return state;
      return { queueBySessionId: { ...state.queueBySessionId, [sessionId]: queue } };
    }),
    clearQueue: (sessionId, queueId) => set((state) => {
      const current = state.queueBySessionId[sessionId];
      if (!current || (queueId && current.queueId !== queueId)) return state;
      const next = { ...state.queueBySessionId };
      delete next[sessionId];
      return { queueBySessionId: next };
    }),
    setSaving: (resourceKey, saving) => set((state) => ({
      savingResourceKeys: saving
        ? [...new Set([...state.savingResourceKeys, resourceKey])]
        : state.savingResourceKeys.filter((key) => key !== resourceKey),
    })),
  };
}

export function createEngineConcurrencyStore(): StoreApi<EngineConcurrencyState> {
  return createStore<EngineConcurrencyState>(stateCreator);
}

export const useEngineConcurrencyStore = create<EngineConcurrencyState>(stateCreator);
