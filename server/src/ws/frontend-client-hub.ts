import { WebSocket as WSClient } from 'ws';
import {
  FrontendEventSchema,
  type FrontendEvent,
  type ProjectDto,
  type SessionDto,
  type SidebarOrderDto,
  type ClientEnvironmentDto,
  type ClientDiagnosticsDto,
  type PublicUserDto,
} from '../contracts/index.js';
import { onAuthSessionRevoked, onUserAccessRevoked } from '../auth/revocation.js';
import type { Actor } from '../auth/authorization.js';
import { getDB } from '../db/index.js';

export interface FrontendClient {
  ws: WSClient;
  actor: Actor;
  userId: string;
  user: PublicUserDto;
  ip: string;
  clientEnvironment?: ClientEnvironmentDto;
  clientDiagnostics?: ClientDiagnosticsDto;
  resourceScope?: 'mine' | 'all';
  deviceId?: string;
  authTokenHash: string;
  authExpiresAt: number;
  authExpiryTimer: ReturnType<typeof setTimeout> | null;
  activeSubscriptionSessionId: string | null;
  subscribedSessionIds: Set<string>;
}

export function setClientContext(
  client: FrontendClient,
  environment?: ClientEnvironmentDto,
  diagnostics?: ClientDiagnosticsDto,
): void {
  if (environment) client.clientEnvironment = environment;
  if (diagnostics) client.clientDiagnostics = diagnostics;
}

/** 记录发起连接的设备标识，用于区分授权决定是本机还是其他设备做出的。 */
export function setClientDevice(client: FrontendClient, deviceId?: string): void {
  if (typeof deviceId === 'string' && deviceId.trim()) client.deviceId = deviceId.trim();
}

type SessionScopedFrontendEvent = Exclude<FrontendEvent, {
  type: 'protocol_info' | 'pending_approvals_snapshot' | 'pending_approval_upserted' | 'interaction_response_result';
}> & { sessionId: string };

const clients = new Map<WSClient, FrontendClient>();
const subscribers = new Map<string, Set<WSClient>>();
export const MAX_CLIENT_SESSION_SUBSCRIPTIONS = 16;
const MAX_TIMEOUT_MS = 2_147_000_000;

function closeUnauthenticatedClient(client: FrontendClient, reason: string): void {
  client.authExpiresAt = 0;
  if (client.authExpiryTimer) {
    clearTimeout(client.authExpiryTimer);
    client.authExpiryTimer = null;
  }
  if (client.ws.readyState === WSClient.OPEN || client.ws.readyState === WSClient.CONNECTING) {
    client.ws.close(1008, reason);
  }
}

export function isClientAuthenticated(client: FrontendClient, now = Date.now()): boolean {
  if (client.authExpiresAt > now) return true;
  closeUnauthenticatedClient(client, '登录已过期');
  return false;
}

export function scheduleClientExpiry(client: FrontendClient): void {
  if (client.authExpiryTimer) clearTimeout(client.authExpiryTimer);
  const remaining = client.authExpiresAt - Date.now();
  if (remaining <= 0) {
    closeUnauthenticatedClient(client, '登录已过期');
    return;
  }
  client.authExpiryTimer = setTimeout(() => scheduleClientExpiry(client), Math.min(remaining, MAX_TIMEOUT_MS));
}

export function addFrontendClient(client: FrontendClient): void {
  clients.set(client.ws, client);
  scheduleClientExpiry(client);
}

export function deleteFrontendClient(client: FrontendClient): string[] {
  if (client.authExpiryTimer) clearTimeout(client.authExpiryTimer);
  client.authExpiryTimer = null;
  const previousSessionIds = removeAllClientSubscriptions(client);
  clients.delete(client.ws);
  return previousSessionIds;
}

function validateFrontendEvent<T extends FrontendEvent>(event: T): T {
  if (event.type === 'delta' && process.env.NODE_ENV === 'production') return event;
  return FrontendEventSchema.parse(event) as T;
}

export function sendFrontendEvent(ws: WSClient, event: FrontendEvent): void {
  ws.send(JSON.stringify(validateFrontendEvent(event)));
}

export function mergeSessionEventRecipients<T>(
  sessionSubscribers: Iterable<T> | undefined,
  initiator?: T,
): Set<T> {
  const recipients = new Set(sessionSubscribers);
  if (initiator !== undefined) recipients.add(initiator);
  return recipients;
}

export function broadcastFrontendEvent(event: SessionScopedFrontendEvent, initiator?: WSClient): void {
  const parsed = validateFrontendEvent(event);
  const payload = JSON.stringify(parsed);
  for (const ws of mergeSessionEventRecipients(subscribers.get(parsed.sessionId), initiator)) {
    const client = clients.get(ws);
    if (client && isClientAuthenticated(client) && ws.readyState === WSClient.OPEN) ws.send(payload);
  }
}

export function broadcastAuthenticatedFrontendEvent(event: FrontendEvent): void {
  const payload = JSON.stringify(validateFrontendEvent(event));
  for (const [ws, client] of clients) {
    if (isClientAuthenticated(client) && ws.readyState === WSClient.OPEN) ws.send(payload);
  }
}

export function broadcastActorFrontendEvent(build: (actor: Actor) => FrontendEvent): void {
  for (const [ws, client] of clients) {
    if (!isClientAuthenticated(client) || ws.readyState !== WSClient.OPEN) continue;
    ws.send(JSON.stringify(validateFrontendEvent(build(client.actor))));
  }
}

export function broadcastUserFrontendEvent(userId: string, event: FrontendEvent): void {
  const payload = JSON.stringify(validateFrontendEvent(event));
  for (const [ws, client] of clients) {
    if (client.userId === userId && isClientAuthenticated(client) && ws.readyState === WSClient.OPEN) ws.send(payload);
  }
}

export function broadcastResourceFrontendEvent(ownerUserId: string, event: FrontendEvent): void {
  const payload = JSON.stringify(validateFrontendEvent(event));
  for (const [ws, client] of clients) {
    if ((client.actor.userId === ownerUserId || client.actor.role === 'admin')
      && isClientAuthenticated(client) && ws.readyState === WSClient.OPEN) ws.send(payload);
  }
}

export function broadcastSessionResourceEvent(sessionId: string, ownerUserId: string, event: FrontendEvent): void {
  const payload = JSON.stringify(validateFrontendEvent(event));
  for (const [ws, client] of clients) {
    const isOwner = client.actor.userId === ownerUserId;
    const isAdminInScope = client.actor.role === 'admin'
      && (client.resourceScope === 'all' || client.activeSubscriptionSessionId === sessionId);
    if ((isOwner || isAdminInScope) && isClientAuthenticated(client) && ws.readyState === WSClient.OPEN) ws.send(payload);
  }
}

export function setClientResourceScope(client: FrontendClient, scope: 'mine' | 'all' = 'mine'): void {
  client.resourceScope = scope;
}

function canReceiveSharedSession(projectId: string | null | undefined, userId: string, sessionOwnerId: string): boolean {
  if (userId === sessionOwnerId) return true;
  if (!projectId) return false;
  const ownerId = getDB().get('SELECT owner_user_id FROM projects WHERE id = ? AND deleted_at IS NULL', [projectId])?.owner_user_id;
  if (ownerId && String(ownerId) === userId) return true;
  return getDB().get(
    'SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ? AND can_view_sessions = 1',
    [projectId, userId],
  )?.ok === 1;
}

function broadcastProjectMembers(projectId: string | null | undefined, event: FrontendEvent, canReceive?: (userId: string) => boolean): void {
  if (!projectId) return;
  const ownerId = getDB().get('SELECT owner_user_id FROM projects WHERE id = ?', [projectId])?.owner_user_id;
  const members = getDB().all('SELECT user_id FROM project_members WHERE project_id = ?', [projectId]);
  const ids = new Set(members.map((row) => String(row.user_id)));
  if (ownerId) ids.add(String(ownerId));
  const payload = JSON.stringify(validateFrontendEvent(event));
  for (const [ws, client] of clients) {
    if (ids.has(client.userId) && (!canReceive || canReceive(client.userId)) && isClientAuthenticated(client) && ws.readyState === WSClient.OPEN) ws.send(payload);
  }
}

export function broadcastSessionUpdate(session: SessionDto, ownerUserId?: string | null): void {
  const ownerId = ownerUserId ?? session.owner?.id;
  if (!ownerId) return;
  broadcastResourceFrontendEvent(ownerId, { type: 'session_updated', sessionId: session.id, session });
  broadcastProjectMembers(session.project_id, { type: 'session_updated', sessionId: session.id, session }, (userId) => (
    canReceiveSharedSession(session.project_id, userId, ownerId)
  ));
}

export function broadcastSessionDelete(sessionId: string, ownerUserId: string): void {
  broadcastResourceFrontendEvent(ownerUserId, { type: 'session_deleted', sessionId });
  const row = getDB().get('SELECT project_id FROM sessions WHERE id = ?', [sessionId]) as { project_id?: string | null } | undefined;
  broadcastProjectMembers(row?.project_id, { type: 'session_deleted', sessionId }, (userId) => canReceiveSharedSession(row?.project_id, userId, ownerUserId));
}

export function broadcastSessionDeletionProgress(
  sessionId: string,
  stage: 'stopping' | 'archiving' | 'saving' | null,
  ownerUserId: string,
): void {
  broadcastResourceFrontendEvent(ownerUserId, { type: 'session_deletion_progress', sessionId, stage });
  const row = getDB().get('SELECT project_id FROM sessions WHERE id = ?', [sessionId]) as { project_id?: string | null } | undefined;
  broadcastProjectMembers(row?.project_id, { type: 'session_deletion_progress', sessionId, stage }, (userId) => canReceiveSharedSession(row?.project_id, userId, ownerUserId));
}

export function broadcastProjectUpdate(project: ProjectDto, ownerUserId?: string | null): void {
  const ownerId = ownerUserId ?? project.owner?.id;
  if (!ownerId) return;
  broadcastResourceFrontendEvent(ownerId, { type: 'project_updated', project });
  broadcastProjectMembers(project.id, { type: 'project_updated', project });
}

export function broadcastProjectDelete(projectId: string, ownerUserId: string): void {
  broadcastResourceFrontendEvent(ownerUserId, { type: 'project_deleted', projectId });
  broadcastProjectMembers(projectId, { type: 'project_deleted', projectId });
}

export function broadcastSidebarOrderUpdate(order: SidebarOrderDto, ownerUserId?: string): void {
  if (!ownerUserId) return;
  broadcastUserFrontendEvent(ownerUserId, { type: 'sidebar_order_updated', order });
}

export function broadcastApprovalTrustUpdate(
  event: Extract<FrontendEvent, { type: 'approval_trust_updated' }>,
  ownerUserId: string,
): void {
  broadcastUserFrontendEvent(ownerUserId, event);
}

export function setClientSubscription(client: FrontendClient, sessionId: string, active: boolean): boolean {
  if (client.subscribedSessionIds.has(sessionId)) {
    if (active) client.activeSubscriptionSessionId = sessionId;
    else if (client.activeSubscriptionSessionId === sessionId) client.activeSubscriptionSessionId = null;
    return false;
  }
  if (client.subscribedSessionIds.size >= MAX_CLIENT_SESSION_SUBSCRIPTIONS) {
    throw new Error(`单个连接最多订阅 ${MAX_CLIENT_SESSION_SUBSCRIPTIONS} 个会话`);
  }
  client.subscribedSessionIds.add(sessionId);
  if (active) client.activeSubscriptionSessionId = sessionId;
  const sessionSubscribers = subscribers.get(sessionId) || new Set<WSClient>();
  sessionSubscribers.add(client.ws);
  subscribers.set(sessionId, sessionSubscribers);
  return true;
}

export function removeClientSubscription(client: FrontendClient, sessionId: string): boolean {
  if (!client.subscribedSessionIds.delete(sessionId)) return false;
  const sessionSubscribers = subscribers.get(sessionId);
  sessionSubscribers?.delete(client.ws);
  if (sessionSubscribers?.size === 0) subscribers.delete(sessionId);
  if (client.activeSubscriptionSessionId === sessionId) client.activeSubscriptionSessionId = null;
  return true;
}

export function removeAllClientSubscriptions(client: FrontendClient): string[] {
  const sessionIds = [...client.subscribedSessionIds];
  for (const sessionId of sessionIds) removeClientSubscription(client, sessionId);
  return sessionIds;
}

export function getClientSubscribedSessionIds(client: FrontendClient): string[] {
  return [...client.subscribedSessionIds];
}

export function getSessionSubscriberCount(sessionId: string): number {
  return subscribers.get(sessionId)?.size || 0;
}

onAuthSessionRevoked((tokenHash) => {
  for (const client of clients.values()) {
    if (client.authTokenHash === tokenHash) closeUnauthenticatedClient(client, '登录已退出');
  }
});

onUserAccessRevoked((userId) => {
  for (const client of clients.values()) {
    if (client.actor.userId === userId) closeUnauthenticatedClient(client, '账号访问已撤销');
  }
});
