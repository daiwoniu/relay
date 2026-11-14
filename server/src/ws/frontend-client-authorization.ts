import { WebSocket as WSClient } from 'ws';
import { RELAY_PROTOCOL_VERSION, presentPublicUser } from '../contracts/index.js';
import { getAuthenticatedUser } from '../db/queries-account.js';
import { sendFrontendEvent, type FrontendClient } from './frontend-client-hub.js';

export function authorizeFrontendClientSession(
  client: FrontendClient,
  sessionId: string,
  requireSession: (actor: FrontendClient['actor'], sessionId: string) => unknown,
): boolean {
  const user = getAuthenticatedUser(client.authTokenHash);
  if (!user) {
    client.authExpiresAt = 0;
    if (client.ws.readyState === WSClient.OPEN || client.ws.readyState === WSClient.CONNECTING) {
      client.ws.close(1008, '登录已失效');
    }
    return false;
  }
  client.actor = { userId: user.id, role: user.role };
  client.userId = user.id;
  client.user = presentPublicUser(user);
  try {
    requireSession(client.actor, sessionId);
    return true;
  } catch {
    sendFrontendEvent(client.ws, {
      type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId,
      message: '会话不存在', code: 'SESSION_NOT_FOUND',
    });
    return false;
  }
}
