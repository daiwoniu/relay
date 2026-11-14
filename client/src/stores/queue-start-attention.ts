import { create } from 'zustand';
export interface QueueStartAttentionEvent { sequence: number; userId: string; sessionId: string; sessionTitle: string; queueId: string }
interface State { nextSequence: number; events: QueueStartAttentionEvent[]; publish(event: Omit<QueueStartAttentionEvent, 'sequence'>): void; acknowledge(sequence: number): void }
export const useQueueStartAttentionStore = create<State>((set) => ({
  nextSequence: 1, events: [],
  publish: (event) => set((state) => ({ nextSequence: state.nextSequence + 1, events: [...state.events, { ...event, sequence: state.nextSequence }].slice(-50) })),
  acknowledge: (sequence) => set((state) => ({ events: state.events.filter((event) => event.sequence > sequence) })),
}));
