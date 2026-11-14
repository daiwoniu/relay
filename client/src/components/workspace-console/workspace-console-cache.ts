import type { CodexAccountSnapshotDto, WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';

export const CACHE_TTL_MS = 60 * 60 * 1000;
export const RESPONSIBILITY_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
export const CODEX_CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedValue<T> { value: T; fetchedAt: number }
interface CachedSources {
  dashboard?: CachedValue<WorkspaceConsoleDashboardDto>;
  responsibility?: CachedValue<WorkspaceConsoleResponsibilityDto>;
  codex?: CachedValue<CodexAccountSnapshotDto>;
}

const byUser = new Map<string, CachedSources>();
const pending = new Map<string, Promise<unknown>>();
const codexRequestVersion = new Map<string, number>();
const dashboardRequestVersion = new Map<string, number>();
const codexListeners = new Map<string, Set<(value: CodexAccountSnapshotDto) => void>>();
const codexResourceOwners = new Map<string, Set<(value: CodexAccountSnapshotDto) => void>>();
const isFresh = (entry: CachedValue<unknown> | undefined, now: number, ttl = CACHE_TTL_MS) =>
  Boolean(entry && now >= entry.fetchedAt && now - entry.fetchedAt < ttl);

function storedSources(userId: string): CachedSources {
  const current = byUser.get(userId);
  if (current) return current;
  if (typeof sessionStorage === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(`relay:workspace-console:${userId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CachedSources;
    const sources: CachedSources = {};
    if (parsed.responsibility?.value && Number.isFinite(parsed.responsibility.fetchedAt)
      && typeof parsed.responsibility.value.sourceUserKey === 'string'
      && Array.isArray(parsed.responsibility.value.workbenchItems)) sources.responsibility = parsed.responsibility;
    if (parsed.codex?.value?.status === 'ready' && Number.isFinite(parsed.codex.fetchedAt)) sources.codex = parsed.codex;
    byUser.set(userId, sources);
    return sources;
  } catch { return {}; }
}

function persistSuccessfulSources(userId: string): void {
  if (typeof sessionStorage === 'undefined') return;
  const { responsibility, codex } = byUser.get(userId) ?? {};
  try { sessionStorage.setItem(`relay:workspace-console:${userId}`, JSON.stringify({ responsibility, codex })); }
  catch { /* Storage can be unavailable or full; the in-memory cache still works. */ }
}

export function readWorkspaceConsoleCache(userId: string, now = Date.now()) {
  const entry = storedSources(userId);
  return {
    dashboard: entry?.dashboard?.value ?? null,
    responsibility: entry?.responsibility?.value ?? null,
    dashboardFresh: isFresh(entry?.dashboard, now),
    responsibilityFresh: isFresh(entry?.responsibility, now, RESPONSIBILITY_CACHE_TTL_MS),
  };
}

export function rememberDashboard(userId: string, value: WorkspaceConsoleDashboardDto, fetchedAt = Date.now()) {
  byUser.set(userId, { ...storedSources(userId), dashboard: { value, fetchedAt } });
}

export function rememberResponsibility(userId: string, value: WorkspaceConsoleResponsibilityDto, fetchedAt = Date.now()) {
  byUser.set(userId, { ...storedSources(userId), responsibility: { value, fetchedAt } });
  persistSuccessfulSources(userId);
}

export function invalidateWorkspaceDashboard(userId?: string): void {
  const keys = userId ? [userId] : [...new Set([...byUser.keys(), ...dashboardRequestVersion.keys()])];
  for (const key of keys) {
    dashboardRequestVersion.set(key, (dashboardRequestVersion.get(key) ?? 0) + 1);
    const entry = byUser.get(key);
    if (entry) byUser.set(key, { ...entry, dashboard: undefined });
  }
}

export function loadWorkspaceDashboard(userId: string, fetcher: () => Promise<WorkspaceConsoleDashboardDto>, force = false): Promise<WorkspaceConsoleDashboardDto> {
  const version = dashboardRequestVersion.get(userId) ?? 0;
  dashboardRequestVersion.set(userId, version);
  return coalesceWorkspaceRequest(userId, 'dashboard', async () => {
    let value: WorkspaceConsoleDashboardDto;
    try { value = await fetcher(); }
    catch (error) {
      if (dashboardRequestVersion.get(userId) !== version) return loadWorkspaceDashboard(userId, fetcher, force);
      throw error;
    }
    if (dashboardRequestVersion.get(userId) !== version) return loadWorkspaceDashboard(userId, fetcher, force);
    if (value.errors.length === 0 && value.sourceMeta?.state !== 'failed_snapshot')
      rememberDashboard(userId, value, value.sourceMeta?.lastSuccessAt ?? value.capturedAt ?? Date.now());
    return value;
  }, force);
}

export function readWorkspaceCodexCache(userId: string, now = Date.now()) {
  const entry = storedSources(userId).codex;
  const usage = entry?.value.usage;
  const credits = entry?.value.rateLimitResetCredits?.credits;
  const compatible = (!usage || ['longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays']
    .every((field) => field in usage)) && (!credits || credits.every((credit) => 'id' in credit));
  return { value: compatible ? entry?.value ?? null : null,
    fresh: Boolean(compatible && entry && now >= entry.fetchedAt && now - entry.fetchedAt < CODEX_CACHE_TTL_MS) };
}

export function subscribeWorkspaceCodexCache(userId: string, listener: (value: CodexAccountSnapshotDto) => void, resourceOwner = false): () => void {
  const listeners = codexListeners.get(userId) ?? new Set();
  listeners.add(listener);
  codexListeners.set(userId, listeners);
  if (resourceOwner) {
    const owners = codexResourceOwners.get(userId) ?? new Set();
    owners.add(listener);
    codexResourceOwners.set(userId, owners);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) codexListeners.delete(userId);
    const owners = codexResourceOwners.get(userId);
    owners?.delete(listener);
    if (!owners?.size) codexResourceOwners.delete(userId);
  };
}

export const hasWorkspaceCodexResourceOwner = (userId: string): boolean => !!codexResourceOwners.get(userId)?.size;

function publishCodex(userId: string, value: CodexAccountSnapshotDto, version: number, now: number) {
  if (value.status !== 'ready' || codexRequestVersion.get(userId) !== version) return;
  byUser.set(userId, { ...storedSources(userId), codex: {
    value, fetchedAt: value.sourceMeta?.lastSuccessAt ?? value.fetchedAt ?? now,
  } });
  persistSuccessfulSources(userId);
  for (const listener of codexListeners.get(userId) ?? []) { try { listener(value); } catch {} }
}

export function loadWorkspaceCodexResources<T extends { account: CodexAccountSnapshotDto }>(userId: string, fetcher: () => Promise<T>): Promise<T> {
  const key = `${userId}:codex-resources`;
  const current = pending.get(key);
  if (current) return current as Promise<T>;
  const version = (codexRequestVersion.get(userId) ?? 0) + 1;
  codexRequestVersion.set(userId, version);
  const next = fetcher().then((value) => {
    publishCodex(userId, value.account, version, Date.now());
    const latest = storedSources(userId).codex?.value;
    return codexRequestVersion.get(userId) !== version && latest ? { ...value, account: latest } : value;
  })
    .finally(() => { if (pending.get(key) === next) pending.delete(key); });
  pending.set(key, next);
  return next;
}

export function loadWorkspaceCodexAccount(
  userId: string,
  fetcher: () => Promise<CodexAccountSnapshotDto>,
  force = false,
  now = Date.now(),
): Promise<CodexAccountSnapshotDto> {
  const key = `${userId}:codex${force ? ':force' : ''}`;
  const current = pending.get(key);
  if (current) return current as Promise<CodexAccountSnapshotDto>;
  const version = (codexRequestVersion.get(userId) ?? 0) + 1;
  codexRequestVersion.set(userId, version);
  const next = fetcher().then((value) => {
    publishCodex(userId, value, version, now);
    return codexRequestVersion.get(userId) !== version ? storedSources(userId).codex?.value ?? value : value;
  }).finally(() => { if (pending.get(key) === next) pending.delete(key); });
  pending.set(key, next);
  return next;
}

export function coalesceWorkspaceRequest<T>(userId: string, source: 'dashboard' | 'responsibility', request: () => Promise<T>, force = false): Promise<T> {
  const base = `${userId}:${source}${source === 'dashboard' ? `:${dashboardRequestVersion.get(userId) ?? 0}` : ''}`;
  const key = force ? `${base}:force` : base;
  const forced = pending.get(`${base}:force`);
  if (forced) return forced as Promise<T>;
  const current = pending.get(key);
  if (current) return current as Promise<T>;
  const warm = force ? pending.get(base) : undefined;
  const next = (warm ? warm.catch(() => undefined).then(request) : request())
    .finally(() => { if (pending.get(key) === next) pending.delete(key); });
  pending.set(key, next);
  return next;
}
