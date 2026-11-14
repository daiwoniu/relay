import { createCodexAccountReader,accountIdentity,type RpcClient } from './codex-account-reader.js';
import { ensureCodexProcessReady, releaseCodexProcessReady } from './codex-lifecycle.js';
import type { CodexAccountSnapshotDto } from '../contracts/index.js';
import { CodexAccountSnapshotDtoSchema } from '../contracts/dto.js';
import { getDB, type SQLiteDB } from '../db/index.js';
import { readWorkspaceSnapshot, writeWorkspaceSnapshot } from '../db/workspace-snapshots.js';

type Dependencies = { ensureReady?: () => Promise<boolean | void>; releaseReady?: () => void; openRpc?: () => Promise<RpcClient>; now?: () => number;
  database?: Pick<SQLiteDB, 'get' | 'run' | 'saveToFile'> };

const CACHE_MS = 30 * 60_000;

export function createCodexAccountService(dependencies: Dependencies = {}) {
  const ensureReady = dependencies.ensureReady ?? (() => ensureCodexProcessReady());
  const releaseReady = dependencies.releaseReady ?? (() => { releaseCodexProcessReady(); });
  const openRpc = dependencies.openRpc;
  const now = dependencies.now ?? Date.now;
  let database: Pick<SQLiteDB, 'get' | 'run' | 'saveToFile'> | null = dependencies.database ?? null;
  const snapshotDatabase = () => {
    if (!database) { try { database = getDB(); } catch { /* Database may not be initialized yet. */ } }
    return database;
  };
  let cached: CodexAccountSnapshotDto | null = null;
  let expiresAt = 0;
  let inflight: Promise<CodexAccountSnapshotDto> | null = null;
  let requestVersion = 0;
  let consuming = false;
  let mustRefresh = false;
  const stored = (identityKey?: string): { value: CodexAccountSnapshotDto; savedAt: number } | null => {
    snapshotDatabase();
    if (!database) return null;
    try {
      const key = identityKey ?? database.get("SELECT identity_key FROM workspace_snapshots WHERE source = 'codex_official' ORDER BY saved_at DESC LIMIT 1")?.identity_key;
      if (typeof key !== 'string') return null;
      const result = readWorkspaceSnapshot(database, 'codex_official', key, CodexAccountSnapshotDtoSchema);
      return result?.value.status === 'ready' && accountIdentity(result.value) === key ? result : null;
    } catch { return null; }
  };
  const hydrate = (): CodexAccountSnapshotDto | null => {
    const previous = stored();
    if (!previous) return null;
    return { ...previous.value, fetchedAt: previous.savedAt, identityVerified: false, sourceMeta: { state: 'snapshot',
      lastSuccessAt: previous.savedAt, lastAttemptAt: null, error: null } };
  };
  const reader=createCodexAccountReader({ensureReady,releaseReady,openRpc,now});
  const readSnapshot=reader.readSnapshot;
  return {
    async consumeResetCredit(params: { idempotencyKey: string; creditId?: string }): Promise<'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'> {
      if (consuming) throw new Error('重置额度操作正在进行');
      consuming = true;
      try {
        const outcome=await reader.consumeResetCredit(params);
        const result={outcome};
        if (result.outcome === 'reset' || result.outcome === 'alreadyRedeemed') {
          requestVersion += 1;
          cached = null;
          expiresAt = 0;
          mustRefresh = true;
        }
        return result.outcome;
      } catch {
        throw new Error('重置额度操作失败，请刷新额度后重试');
      } finally {
        consuming = false;
      }
    },
    /** Candidate adapter entry: provider-only read, never hydrate or save through the legacy database. */
    readFreshSnapshot:()=>readSnapshot(true),
    getSnapshot(force = false): Promise<CodexAccountSnapshotDto> {
      snapshotDatabase();
      if (inflight && !mustRefresh) return inflight;
      if (!force && !mustRefresh && !cached) cached = hydrate();
      if (!force && !mustRefresh && cached && (cached.sourceMeta?.state === 'snapshot' || cached.sourceMeta?.state === 'failed_snapshot' || now() < expiresAt)) return Promise.resolve(cached);
      const version = ++requestVersion;
      mustRefresh = false;
      const request = readSnapshot().then(({ snapshot, limitsOk, usageOk }) => {
        const attemptedAt = snapshot.fetchedAt;
        const confirmedKey = snapshot.status === 'ready' ? accountIdentity(snapshot) : null;
        const previous = confirmedKey
          ? (cached && accountIdentity(cached) === confirmedKey ? cached : stored(confirmedKey)?.value ?? null)
          : snapshot.status === 'unavailable' ? cached ?? hydrate() : null;
        let result = snapshot;
        if (snapshot.status === 'unavailable' && previous) {
          result = { ...previous, identityVerified: false, sourceMeta: { state: 'failed_snapshot', lastSuccessAt: previous.fetchedAt,
            lastAttemptAt: attemptedAt, error: 'Codex 账号暂时无法核实' } };
        } else if (snapshot.status === 'ready' && (!limitsOk || !usageOk)) {
          const message = 'Codex 部分数据暂时无法读取';
          result = { ...snapshot, identityVerified: confirmedKey ? true : undefined,
            fetchedAt: previous?.fetchedAt ?? snapshot.fetchedAt,
            rateLimits: limitsOk ? snapshot.rateLimits : previous?.rateLimits ?? [],
            credits: limitsOk ? snapshot.credits : previous?.credits ?? null,
            rateLimitResetCredits: limitsOk ? snapshot.rateLimitResetCredits : previous?.rateLimitResetCredits ?? null,
            usage: usageOk ? snapshot.usage : previous?.usage ?? null,
            sourceMeta: database ? { state: previous ? 'failed_snapshot' : 'unavailable',
              lastSuccessAt: previous?.fetchedAt ?? null, lastAttemptAt: attemptedAt, error: message } : undefined };
        } else if (snapshot.status === 'ready' && confirmedKey && database) {
          result = { ...snapshot, identityVerified: true, sourceMeta: { state: 'live', lastSuccessAt: attemptedAt,
            lastAttemptAt: attemptedAt, error: null } };
          if (requestVersion === version) {
            const parsed = CodexAccountSnapshotDtoSchema.safeParse(result);
            if (parsed.success) {
              try { writeWorkspaceSnapshot(database, 'codex_official', confirmedKey, parsed.data, attemptedAt); }
              catch { console.warn('[CodexAccount] snapshot save failed'); }
            }
          }
        }
        if (requestVersion === version) {
          cached = result.status === 'ready' ? result : null;
          expiresAt = result.sourceMeta?.state === 'failed_snapshot' ? Number.POSITIVE_INFINITY : now() + CACHE_MS;
          mustRefresh = false;
        }
        return result;
      }).finally(() => { if (inflight === request) inflight = null; });
      inflight = request;
      return request;
    },
  };
}

export type CodexAccountService = Pick<ReturnType<typeof createCodexAccountService>,'getSnapshot'|'consumeResetCredit'>;
export type CodexAccountFreshReader = Pick<ReturnType<typeof createCodexAccountService>,'readFreshSnapshot'>;
