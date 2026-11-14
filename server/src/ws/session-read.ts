import { getDB } from '../db/index.js';
import { markSessionResultRead } from '../db/session-attention.js';
import type { SessionDto } from '../contracts/index.js';
import { broadcastUserFrontendEvent, type FrontendClient } from './frontend-client-hub.js';

export function handleSessionRead(
  client: FrontendClient,
  message: { sessionId: string; messageId: string },
  authorize: (client: FrontendClient, sessionId: string) => boolean,
  getSession: (sessionId: string) => { last_result?: SessionDto['last_result'] } | undefined,
  ports = {
    persist: (userId: string, sessionId: string, messageId: string) => markSessionResultRead(getDB(), userId, sessionId, messageId),
    publish: broadcastUserFrontendEvent,
  },
): void {
  if (!authorize(client, message.sessionId) || client.activeSubscriptionSessionId !== message.sessionId) return;
  const result = getSession(message.sessionId)?.last_result;
  if (!result || result.messageId !== message.messageId) return;
  if (!ports.persist(client.userId, message.sessionId, message.messageId)) return;
  ports.publish(client.userId, { type: 'session_reads', receipts: { [message.sessionId]: message.messageId } });
}
