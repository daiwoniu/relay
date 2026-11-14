import { create } from 'zustand';
import type { SessionDeletionProgressEvent } from '../generated/relay-contracts.ts';

export type SessionDeletionProgressStage = NonNullable<SessionDeletionProgressEvent['stage']>;

interface SessionDeletionProgressState {
  bySessionId: Record<string, SessionDeletionProgressStage>;
  setStage(sessionId: string, stage: SessionDeletionProgressStage | null): void;
  clearStage(sessionId: string): void;
  clearAll(): void;
}

function withoutSession(
  current: Record<string, SessionDeletionProgressStage>,
  sessionId: string,
): Record<string, SessionDeletionProgressStage> {
  if (!(sessionId in current)) return current;
  const next = { ...current };
  delete next[sessionId];
  return next;
}

export const useSessionDeletionProgressStore = create<SessionDeletionProgressState>((set) => ({
  bySessionId: {},
  setStage: (sessionId, stage) => set((state) => ({
    bySessionId: stage ? { ...state.bySessionId, [sessionId]: stage } : withoutSession(state.bySessionId, sessionId),
  })),
  clearStage: (sessionId) => set((state) => ({ bySessionId: withoutSession(state.bySessionId, sessionId) })),
  clearAll: () => set({ bySessionId: {} }),
}));
