import { jsonBody, requestJson } from './client';

export interface MessageRepairPreview {
  planId: string | null;
  expiresAt: number | null;
  turnCount: number;
  sessions: { id: string; title: string; turnCount: number }[];
  nextCursor: string | null;
  issues: { sessionId: string; title: string; turnCount: number; reason: string }[];
}
export const previewMessageRepair = (cursor?: string) => requestJson<MessageRepairPreview>('/api/system/message-repair/preview', {
  method: 'POST', ...jsonBody(cursor ? { cursor } : {}), timeoutMs: 120_000,
});
export const applyMessageRepair = (planId: string) => requestJson<{ restoredCount: number }>('/api/system/message-repair/apply', {
  method: 'POST', ...jsonBody({ planId }), timeoutMs: 180_000,
});
