import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { SQLiteDB } from '../db/index.js';
import { scanCodexLocalUsageEvents } from './codex-local-usage.js';

type UsageDb = Pick<SQLiteDB, 'get' | 'all' | 'run' | 'exec' | 'saveToFile'>;

export interface CodexLocalUsageSnapshot {
  email: string;
  timeZone: 'Asia/Shanghai';
  dailyUsageBuckets: { startDate: string; tokens: number }[];
  backfill: { email: string; completedAt: number } | null;
  sourceMeta?: { state: 'live' | 'failed_snapshot' | 'unavailable'; lastSuccessAt: number | null;
    lastAttemptAt: number | null; error: string | null };
}

const TIME_ZONE = 'Asia/Shanghai';
const CONFIRMED_BACKFILL_START = '2026-09-23';
const CONFIRMED_BACKFILL_END = '2026-09-29';

function shanghaiDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

async function readCurrentAccountId(codexHome: string, expectedEmail: string): Promise<string | null> {
  try {
    const auth = JSON.parse(await readFile(path.join(codexHome, 'auth.json'), 'utf8'));
    const accountId = auth?.tokens?.account_id;
    const idToken = auth?.tokens?.id_token;
    if (typeof accountId !== 'string' || !accountId || typeof idToken !== 'string') return null;
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof claims?.email === 'string' && claims.email.trim().toLowerCase() === expectedEmail ? accountId : null;
  } catch { return null; }
}

export function createCodexLocalUsageService(db: UsageDb, options: {
  codexHome?: string; now?: () => number; readCurrentAccountId?: (email: string) => Promise<string | null>;
  scanEvents?: typeof scanCodexLocalUsageEvents;
} = {}) {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const now = options.now ?? Date.now;
  const accountIdFor = options.readCurrentAccountId ?? ((email: string) => readCurrentAccountId(codexHome, email));
  const scanEvents = options.scanEvents ?? scanCodexLocalUsageEvents;
  let inflight: Promise<void> | null = null;
  let inflightEmail: string | null = null;
  const synchronize = async (currentEmail: string) => {
    const today = shanghaiDay(new Date(now()));
    const since = new Date(`${today}T00:00:00+08:00`);
    since.setUTCDate(since.getUTCDate() - 6);
    const backfill = db.get('SELECT email, completed_at FROM codex_local_usage_backfill WHERE id = 1');
    const currentAccountId = await accountIdFor(currentEmail);
    if (!currentAccountId) throw new Error('Codex account ID is unavailable or does not match the account email');
    const backfillSince = new Date(`${CONFIRMED_BACKFILL_START}T00:00:00+08:00`);
    const scanSince = !backfill && backfillSince < since ? backfillSince : since;
    const events = await scanEvents(codexHome, scanSince, new Date(now() + 1), TIME_ZONE);
    const confirmedEvents = !backfill ? events.filter((event) => event.day >= CONFIRMED_BACKFILL_START
      && event.day <= CONFIRMED_BACKFILL_END) : [];
    const completingBackfill = !backfill && confirmedEvents.length > 0;
    if (confirmedEvents.length > 0 && (!confirmedEvents.some((event) => event.accountId)
      || confirmedEvents.some((event) => event.accountId && event.accountId !== currentAccountId))) {
      throw new Error('Confirmed backfill account differs from or cannot be verified against the current Codex account');
    }
    const accounts = new Map<string, string>(db.all('SELECT creator_account_id, email FROM codex_local_usage_accounts')
      .map((row) => [String(row.creator_account_id), String(row.email)]));
    const previousSync = db.get('SELECT completed_at FROM codex_local_usage_sync WHERE email = ?', [currentEmail]);
    const known = new Set<string>();
    for (let index = 0; index < events.length; index += 500) {
      const fingerprints = events.slice(index, index + 500).map((event) => event.fingerprint);
      const rows = db.all(`SELECT fingerprint FROM codex_local_usage_events WHERE fingerprint IN (${fingerprints.map(() => '?').join(',')})`, fingerprints);
      for (const row of rows) known.add(String(row.fingerprint));
    }
    const insertedFingerprints: string[] = [];
    const insertedAccountIds: string[] = [];
    db.exec('BEGIN');
    try {
      for (const event of events) {
        if (known.has(event.fingerprint)) continue;
        let email: string | null;
        let attribution: 'confirmed_backfill' | 'log_account';
        if (!backfill && event.day >= CONFIRMED_BACKFILL_START && event.day <= CONFIRMED_BACKFILL_END) {
          email = currentEmail;
          attribution = 'confirmed_backfill';
        } else if (event.accountId) {
          email = accounts.get(event.accountId) ?? (event.accountId === currentAccountId ? currentEmail : null);
          if (!email) continue;
          attribution = 'log_account';
        } else {
          // Older logs omit the account ID. Only the user-confirmed initial week can be assigned safely.
          continue;
        }
        if (event.accountId && !accounts.has(event.accountId)) {
          db.run('INSERT INTO codex_local_usage_accounts (creator_account_id, email) VALUES (?, ?)', [event.accountId, email]);
          accounts.set(event.accountId, email);
          insertedAccountIds.push(event.accountId);
        }
        db.run(`INSERT INTO codex_local_usage_events
          (fingerprint, day, email, creator_account_id, tokens, input_tokens, cached_input_tokens, output_tokens, attribution)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [event.fingerprint, event.day, email, event.accountId,
          event.tokens, event.inputTokens, event.cachedInputTokens, event.outputTokens, attribution]);
        insertedFingerprints.push(event.fingerprint);
      }
      if (completingBackfill) {
        db.run('INSERT INTO codex_local_usage_backfill (id, email, completed_at) VALUES (1, ?, ?)', [currentEmail, now()]);
      }
      db.run(`INSERT INTO codex_local_usage_sync (email, completed_at) VALUES (?, ?)
        ON CONFLICT(email) DO UPDATE SET completed_at = excluded.completed_at`, [currentEmail, now()]);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    try { db.saveToFile({ failOnLocked: true }); }
    catch (error) {
      db.exec('BEGIN');
      try {
        for (const fingerprint of insertedFingerprints) {
          db.run('DELETE FROM codex_local_usage_events WHERE fingerprint = ?', [fingerprint]);
        }
        for (const accountId of insertedAccountIds) {
          db.run('DELETE FROM codex_local_usage_accounts WHERE creator_account_id = ?', [accountId]);
        }
        if (completingBackfill) db.run('DELETE FROM codex_local_usage_backfill WHERE id = 1');
        if (previousSync) {
          db.run('UPDATE codex_local_usage_sync SET completed_at = ? WHERE email = ?', [previousSync.completed_at, currentEmail]);
        } else {
          db.run('DELETE FROM codex_local_usage_sync WHERE email = ?', [currentEmail]);
        }
        db.exec('COMMIT');
      } catch (rollbackError) {
        db.exec('ROLLBACK');
        throw rollbackError;
      }
      throw error;
    }
  };
  return {
    async getSnapshot(currentEmail: string): Promise<CodexLocalUsageSnapshot> {
      currentEmail = currentEmail.trim().toLowerCase();
      if (inflight && inflightEmail !== currentEmail) await inflight.catch(() => {});
      if (!inflight) {
        inflightEmail = currentEmail;
        const work = synchronize(currentEmail);
        const pending = work.finally(() => { if (inflight === pending) { inflight = null; inflightEmail = null; } });
        inflight = pending;
      }
      let scanFailed = false;
      try { await inflight; }
      catch { scanFailed = true; }
      const sync = db.get('SELECT completed_at FROM codex_local_usage_sync WHERE email = ?', [currentEmail]);
      const lastSuccessAt = sync ? Number(sync.completed_at) : null;
      const storedCount = Number(db.get('SELECT COUNT(*) AS count FROM codex_local_usage_events WHERE email = ?', [currentEmail])?.count ?? 0);
      const hasStoredUsage = lastSuccessAt !== null || storedCount > 0;
      const today = shanghaiDay(new Date(now()));
      const yearStart = new Date(`${today}T00:00:00+08:00`);
      yearStart.setUTCDate(yearStart.getUTCDate() - 364);
      const rows = db.all(`SELECT day, SUM(tokens) AS tokens FROM codex_local_usage_events
        WHERE email = ? AND day >= ? AND day <= ? GROUP BY day ORDER BY day`, [currentEmail, shanghaiDay(yearStart), today]);
      const byDay = new Map(rows.map((row) => [String(row.day), Number(row.tokens)]));
      const dailyUsageBuckets = scanFailed && !hasStoredUsage ? [] : Array.from({ length: 365 }, (_, index) => {
        const day = shanghaiDay(new Date(yearStart.getTime() + index * 86_400_000));
        return { startDate: day, tokens: byDay.get(day) ?? 0 };
      });
      const backfill = db.get('SELECT email, completed_at FROM codex_local_usage_backfill WHERE id = 1');
      return { email: currentEmail, timeZone: TIME_ZONE,
        dailyUsageBuckets,
        backfill: backfill ? { email: String(backfill.email), completedAt: Number(backfill.completed_at) } : null,
        sourceMeta: { state: scanFailed ? hasStoredUsage ? 'failed_snapshot' : 'unavailable' : 'live',
          lastSuccessAt, lastAttemptAt: now(), error: scanFailed ? '本机用量同步失败' : null } };
    },
  };
}

export type CodexLocalUsageService = ReturnType<typeof createCodexLocalUsageService>;
