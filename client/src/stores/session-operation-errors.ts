import { create } from 'zustand';

export const useSessionOperationErrorStore = create<{
  bySession: Record<string, string>;
  set(sessionId: string, message: string): void;
  clear(sessionId: string): void;
  reset(): void;
}>((set) => ({
  bySession: {},
  set: (sessionId, message) => set(state => ({ bySession: { ...state.bySession, [sessionId]: message } })),
  clear: (sessionId) => set(state => {
    if (!(sessionId in state.bySession)) return state;
    const bySession = { ...state.bySession };
    delete bySession[sessionId];
    return { bySession };
  }),
  reset: () => set({ bySession: {} }),
}));
