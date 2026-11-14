import { create } from 'zustand';
import type { SessionFollowupDto } from '../generated/relay-contracts';

export function hasBlockingFollowups(followups: SessionFollowupDto[] | undefined): boolean {
  return Boolean(followups?.some((item) => !['steered', 'delivered', 'cancelled'].includes(item.state)));
}

export function canCancelFollowup(state: SessionFollowupDto['state']): boolean {
  return state === 'received' || state === 'queued' || state === 'paused' || state === 'uncertain';
}

interface State {
  bySession: Record<string, SessionFollowupDto[]>;
  replace(sessionId: string, followups: SessionFollowupDto[]): void;
  upsert(followup: SessionFollowupDto): void;
  clear(): void;
}

export const useSessionFollowupStore = create<State>((set) => ({
  bySession: {},
  replace: (sessionId, followups) => set((state) => ({
    bySession: { ...state.bySession, [sessionId]: followups },
  })),
  upsert: (followup) => set((state) => {
    const previous = state.bySession[followup.sessionId] || [];
    const others = previous.filter((item) => item.id !== followup.id);
    return { bySession: {
      ...state.bySession,
      [followup.sessionId]: [...others, followup].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    } };
  }),
  clear: () => set({ bySession: {} }),
}));
