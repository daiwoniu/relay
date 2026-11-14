import { create } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { PendingApprovalDto } from '../generated/relay-contracts.ts';
import {
  readHiddenApprovalIds,
  writeHiddenApprovalIds,
  type PendingApprovalStorage,
} from './pending-approval-storage.ts';
import type { BatchAction, BatchApprovalGroup, BatchApprovalItem } from '../components/authorization/batch-approvals.ts';

export interface BatchApprovalState {
  ids: string[];
  items: BatchApprovalItem[];
  action: BatchAction;
  status: 'confirming' | 'submitting' | 'complete';
  requestCount: number;
  sessionCount: number;
  groups: BatchApprovalGroup[];
  processed?: number;
  success?: number;
  skipped?: number;
  failed?: number;
}

export interface PendingApprovalState {
  userId: string | null;
  approvalsById: Record<string, PendingApprovalDto>;
  orderedIds: string[];
  currentId: string | null;
  cardHidden: boolean;
  hiddenIds: string[];
  detailsExpanded: boolean;
  submittingIds: string[];
  batch: BatchApprovalState | null;
  connectionAvailable: boolean;
  liveSequence: number;
  lastLiveApproval: PendingApprovalDto | null;
  configureUser(userId: string | null): void;
  applySnapshot(items: PendingApprovalDto[], live?: boolean): void;
  upsertLive(item: PendingApprovalDto): { isNew: boolean };
  resolve(sessionId: string, interactionId: string): void;
  hideCurrentGeneration(): void;
  showCard(): void;
  select(id: string): void;
  setDetailsExpanded(expanded: boolean): void;
  setSubmitting(id: string, submitting: boolean): void;
  setBatch(batch: BatchApprovalState | null): void;
  setConnectionAvailable(available: boolean): void;
}

const EMPTY_STATE = {
  userId: null,
  approvalsById: {},
  orderedIds: [],
  currentId: null,
  cardHidden: false,
  hiddenIds: [],
  detailsExpanded: false,
  submittingIds: [],
  batch: null,
  connectionAvailable: false,
  liveSequence: 0,
  lastLiveApproval: null,
} satisfies Omit<PendingApprovalState,
  'configureUser' | 'applySnapshot' | 'upsertLive' | 'resolve' | 'hideCurrentGeneration'
  | 'showCard' | 'select' | 'setDetailsExpanded' | 'setSubmitting' | 'setBatch' | 'setConnectionAvailable'>;

function orderApprovals(items: PendingApprovalDto[]): PendingApprovalDto[] {
  const byId = new Map<string, PendingApprovalDto>();
  for (const item of items) byId.set(getPendingApprovalKey(item.sessionId, item.id), item);
  return [...byId.values()].sort((left, right) => (
    left.createdAt - right.createdAt
    || left.sessionId.localeCompare(right.sessionId)
    || left.id.localeCompare(right.id)
  ));
}

export function getPendingApprovalKey(sessionId: string, interactionId: string): string {
  return `${sessionId}::${interactionId}`;
}

function stateCreator(storage?: PendingApprovalStorage | null) {
  return (set: StoreApi<PendingApprovalState>['setState'], get: StoreApi<PendingApprovalState>['getState']): PendingApprovalState => ({
    ...EMPTY_STATE,
    configureUser: (userId) => {
      if (get().userId === userId) return;
      const hiddenIds = userId ? readHiddenApprovalIds(userId, storage) : [];
      set({ ...EMPTY_STATE, userId, hiddenIds });
    },
    applySnapshot: (items, live = false) => set((state) => {
      const ordered = orderApprovals(items);
      const added = live ? ordered.filter(item => !state.approvalsById[getPendingApprovalKey(item.sessionId, item.id)]) : [];
      const approvalsById = Object.fromEntries(ordered.map((item) => [getPendingApprovalKey(item.sessionId, item.id), item]));
      const orderedIds = ordered.map((item) => getPendingApprovalKey(item.sessionId, item.id));
      const currentId = state.currentId && approvalsById[state.currentId]
        ? state.currentId
        : orderedIds[0] || null;
      const hiddenBySavedGeneration = orderedIds.length > 0
        && orderedIds.every((id) => state.hiddenIds.includes(id));
      return {
        approvalsById,
        orderedIds,
        currentId,
        cardHidden: orderedIds.length > 0 && (added.some(item => !state.hiddenIds.includes(getPendingApprovalKey(item.sessionId, item.id))) ? false : state.cardHidden || hiddenBySavedGeneration),
        liveSequence: state.liveSequence + added.length,
        lastLiveApproval: added[added.length - 1] || state.lastLiveApproval,
      };
    }),
    upsertLive: (item) => {
      const state = get();
      const approvalKey = getPendingApprovalKey(item.sessionId, item.id);
      const isNew = !state.approvalsById[approvalKey];
      set((current) => {
        const ordered = orderApprovals([...Object.values(current.approvalsById), item]);
        return {
          approvalsById: Object.fromEntries(ordered.map((approval) => [getPendingApprovalKey(approval.sessionId, approval.id), approval])),
          orderedIds: ordered.map((approval) => getPendingApprovalKey(approval.sessionId, approval.id)),
          currentId: current.currentId || approvalKey,
          cardHidden: isNew && !current.hiddenIds.includes(approvalKey) ? false : current.cardHidden,
          liveSequence: isNew ? current.liveSequence + 1 : current.liveSequence,
          lastLiveApproval: isNew ? item : current.lastLiveApproval,
        };
      });
      return { isNew };
    },
    resolve: (sessionId, interactionId) => {
      const id = getPendingApprovalKey(sessionId, interactionId);
      const current = get();
      if (!current.approvalsById[id]) return;
      const hiddenIds = current.hiddenIds.filter((candidate) => candidate !== id);
      if (current.userId) writeHiddenApprovalIds(current.userId, hiddenIds, storage);
      set((state) => {
        const removedIndex = state.orderedIds.indexOf(id);
        const orderedIds = state.orderedIds.filter((candidate) => candidate !== id);
        const approvalsById = { ...state.approvalsById };
        delete approvalsById[id];
        const currentId = state.currentId === id
          ? orderedIds[Math.min(Math.max(removedIndex, 0), orderedIds.length - 1)] || null
          : state.currentId;
        return {
          approvalsById,
          orderedIds,
          currentId,
          hiddenIds,
          detailsExpanded: currentId ? state.detailsExpanded : false,
          submittingIds: state.submittingIds.filter((candidate) => candidate !== id),
          cardHidden: orderedIds.length > 0 ? state.cardHidden : false,
        };
      });
    },
    hideCurrentGeneration: () => {
      const state = get();
      const hiddenIds = [...state.orderedIds];
      if (state.userId) writeHiddenApprovalIds(state.userId, hiddenIds, storage);
      set({ cardHidden: true, hiddenIds });
    },
    showCard: () => {
      const state = get();
      const visibleIds = new Set(state.orderedIds);
      const hiddenIds = state.hiddenIds.filter((id) => !visibleIds.has(id));
      if (state.userId) writeHiddenApprovalIds(state.userId, hiddenIds, storage);
      set({ cardHidden: false, hiddenIds });
    },
    select: (id) => set((state) => state.approvalsById[id] ? { currentId: id, detailsExpanded: false } : state),
    setDetailsExpanded: (detailsExpanded) => set({ detailsExpanded }),
    setSubmitting: (id, submitting) => set((state) => ({
      submittingIds: submitting
        ? [...new Set([...state.submittingIds, id])]
        : state.submittingIds.filter((candidate) => candidate !== id),
    })),
    setBatch: (batch) => set({ batch }),
    setConnectionAvailable: (connectionAvailable) => set({ connectionAvailable }),
  });
}

export function createPendingApprovalStore(storage?: PendingApprovalStorage | null): StoreApi<PendingApprovalState> {
  return createStore<PendingApprovalState>(stateCreator(storage));
}

export const usePendingApprovalStore = create<PendingApprovalState>(stateCreator());
