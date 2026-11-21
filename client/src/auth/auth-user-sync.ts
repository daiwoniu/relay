import type { AuthUser } from '../api/auth';

const CHANNEL_NAME = 'relay-auth-user-v1';
type UserListener = (user: AuthUser) => void;

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === 'string'
    && typeof user.username === 'string'
    && (user.role === 'admin' || user.role === 'member')
    && typeof user.displayName === 'string'
    && (user.avatarUpdatedAt === null || typeof user.avatarUpdatedAt === 'number')
    && (user.defaultProjectId === null || typeof user.defaultProjectId === 'string')
    && (user.defaultEngine === 'codex' || user.defaultEngine === 'codebuddy' || user.defaultEngine === 'opencode' || user.defaultEngine === 'zcode')
    && (user.defaultModelId === null || typeof user.defaultModelId === 'string')
    && (user.defaultReasoningEffort === undefined || user.defaultReasoningEffort === null || typeof user.defaultReasoningEffort === 'string')
    && (user.defaultServiceTier === undefined || user.defaultServiceTier === null || typeof user.defaultServiceTier === 'string')
    && typeof user.mustChangePassword === 'boolean'
    && (user.disabledAt === null || typeof user.disabledAt === 'number');
}

export function isAuthUserUpdateForCurrentUser(currentUser: AuthUser | null, nextUser: AuthUser): boolean {
  return currentUser !== null && currentUser.id === nextUser.id;
}

export function createAuthUserSync(onUser: UserListener): { broadcast: (user: AuthUser) => void; close: () => void } {
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
  if (!channel) return { broadcast: () => undefined, close: () => undefined };
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (isAuthUser(event.data)) onUser(event.data);
  };
  return {
    broadcast: (user) => channel.postMessage(user),
    close: () => channel.close(),
  };
}
