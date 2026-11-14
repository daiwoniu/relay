import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodexLocalUsage, scanCodexLocalUsageEvents } from './codex-local-usage.js';

test('scans only Relay Codex OpenAI token events and removes fork copies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  const event = (at: string, total: number, last: number) => JSON.stringify({
    timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { total_tokens: total },
      last_token_usage: { input_tokens: last - 2, cached_input_tokens: 1, output_tokens: 2, total_tokens: last },
    } },
  });
  const meta = (originator: string, provider = 'openai', accountId?: string) => JSON.stringify({
    type: 'session_meta', payload: { originator, model_provider: provider, creator_account_id: accountId },
  });
  const a = event('2026-09-28T15:59:59.000Z', 10, 10);
  const b = event('2026-09-28T16:00:01.000Z', 20, 10);
  fs.writeFileSync(path.join(root, 'sessions', 'a.jsonl'), [meta('relay', 'openai', 'account-a'), a, b].join('\n'));
  fs.writeFileSync(path.join(root, 'sessions', 'fork.jsonl'), [meta('relay', 'openai', 'account-a'), a, b].join('\n'));
  fs.writeFileSync(path.join(root, 'sessions', 'cli.jsonl'), [meta('codex-tui'), event('2026-09-28T16:00:02.000Z', 30, 10)].join('\n'));
  fs.writeFileSync(path.join(root, 'sessions', 'custom.jsonl'), [meta('relay', 'xs_custom'), event('2026-09-28T16:00:03.000Z', 40, 10)].join('\n'));

  const rows = await scanCodexLocalUsage(root, new Date('2026-09-23T00:00:00+08:00'), new Date('2026-09-30T00:00:00+08:00'), 'Asia/Shanghai');
  assert.deepEqual(rows.map(({ day, tokens, accountId }) => ({ day, tokens, accountId })), [
    { day: '2026-09-28', tokens: 10, accountId: 'account-a' },
    { day: '2026-09-29', tokens: 10, accountId: 'account-a' },
  ]);
  const events = await scanCodexLocalUsageEvents(root, new Date('2026-09-23T00:00:00+08:00'), new Date('2026-09-30T00:00:00+08:00'), 'Asia/Shanghai');
  assert.equal(events.length, 2);
  assert.notEqual(events[0].fingerprint, events[1].fingerprint);
});

test('does not silently accept an unreadable session tree as a complete scan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-unreadable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'sessions'), 'not a directory');
  await assert.rejects(scanCodexLocalUsageEvents(root, new Date('2026-09-23'), new Date('2026-09-30')));
});
