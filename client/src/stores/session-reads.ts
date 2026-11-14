import { create } from 'zustand';

export const useSessionReadStore = create<{
  receipts: Record<string, string>;
  merge(receipts: Record<string, string>): void;
  reset(): void;
}>((set) => ({
  receipts: {},
  merge: (receipts) => set((state) => ({ receipts: { ...state.receipts, ...receipts } })),
  reset: () => set({ receipts: {} }),
}));
