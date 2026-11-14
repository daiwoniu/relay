import { create } from 'zustand';
import type { SessionEndAttentionEvent } from '../notifications/session-end-policy.ts';

interface SessionEndAttentionState {
  nextSequence: number;
  events: SessionEndAttentionEvent[];
  publish(event: Omit<SessionEndAttentionEvent, 'sequence'>): void;
  acknowledge(sequence: number): void;
}

export const useSessionEndAttentionStore = create<SessionEndAttentionState>((set) => ({
  nextSequence: 1,
  events: [],
  publish: (event) => set((state) => ({
    nextSequence: state.nextSequence + 1,
    events: [...state.events, { ...event, sequence: state.nextSequence }].slice(-50),
  })),
  acknowledge: (sequence) => set((state) => ({ events: state.events.filter((event) => event.sequence > sequence) })),
}));
