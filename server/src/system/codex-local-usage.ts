import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export interface CodexLocalUsageRow {
  day: string;
  accountId: string | null;
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface CodexLocalUsageEvent extends CodexLocalUsageRow {
  fingerprint: string;
}

async function* sessionFiles(root: string): AsyncGenerator<string> {
  for (const folder of ['sessions', 'archived_sessions']) {
    const topLevel = path.join(root, folder);
    const pending = [topLevel];
    while (pending.length) {
      const directory = pending.pop()!;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory === topLevel) continue;
        throw error;
      }
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield target;
      }
    }
  }
}

function dayInZone(timestamp: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(timestamp);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function scanCodexLocalUsageEvents(root: string, since: Date, until: Date,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<CodexLocalUsageEvent[]> {
  const seen = new Set<string>();
  const events: CodexLocalUsageEvent[] = [];
  const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  for await (const filename of sessionFiles(root)) {
    try {
      if ((await stat(filename)).mtimeMs < since.getTime()) continue;
      const lines = readline.createInterface({ input: createReadStream(filename, { encoding: 'utf8' }), crlfDelay: Infinity });
      let originator: string | null = null;
      let provider: string | null = null;
      let accountId: string | null = null;
      let previousTotal: number | null = null;
      for await (const line of lines) {
        if (!line.includes('session_meta') && !line.includes('token_count')) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type === 'session_meta') {
          originator = entry.payload?.originator ?? null;
          provider = entry.payload?.model_provider ?? null;
          accountId = typeof entry.payload?.creator_account_id === 'string' ? entry.payload.creator_account_id : null;
          continue;
        }
        if (originator !== 'relay' || provider !== 'openai' || entry?.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
        const info = entry.payload.info;
        const last = info?.last_token_usage;
        const total = info?.total_token_usage?.total_tokens;
        if (!Number.isSafeInteger(last?.total_tokens) || last.total_tokens < 0 ||
          !Number.isSafeInteger(last?.input_tokens) || !Number.isSafeInteger(last?.output_tokens) ||
          !Number.isSafeInteger(total) || total < 0) continue;
        const timestamp = Date.parse(entry.timestamp);
        if (!Number.isFinite(timestamp)) continue;
        const increment = previousTotal === null || total < previousTotal ? last.total_tokens : total - previousTotal;
        previousTotal = total;
        if (timestamp < since.getTime() || timestamp >= until.getTime() || increment <= 0) continue;
        const fingerprint = createHash('sha256').update(line).digest('hex');
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        const day = dayInZone(timestamp, dayFormatter);
        events.push({ fingerprint, day, accountId, tokens: increment,
          inputTokens: last.input_tokens,
          cachedInputTokens: Number.isSafeInteger(last.cached_input_tokens) ? last.cached_input_tokens : 0,
          outputTokens: last.output_tokens });
      }
    } catch (error) { throw error; }
  }
  return events;
}

export async function scanCodexLocalUsage(root: string, since: Date, until: Date,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<CodexLocalUsageRow[]> {
  const grouped = new Map<string, CodexLocalUsageRow>();
  for (const event of await scanCodexLocalUsageEvents(root, since, until, timeZone)) {
    const key = `${event.day}\0${event.accountId ?? ''}`;
    const row = grouped.get(key) ?? { day: event.day, accountId: event.accountId, tokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    row.tokens += event.tokens;
    row.inputTokens += event.inputTokens;
    row.cachedInputTokens += event.cachedInputTokens;
    row.outputTokens += event.outputTokens;
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) => a.day.localeCompare(b.day) || (a.accountId ?? '').localeCompare(b.accountId ?? ''));
}
