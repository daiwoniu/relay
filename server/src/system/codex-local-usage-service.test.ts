import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import { ensureCodexLocalUsageTables } from '../db/codex-local-usage-migration.js';
import { createCodexLocalUsageService } from './codex-local-usage-service.js';

test('backfills the confirmed week once and keeps usage pinned after an account switch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions);
  const meta = (id?: string) => JSON.stringify({ type: 'session_meta', payload: {
    originator: 'relay', model_provider: 'openai', creator_account_id: id,
  } });
  const token = (timestamp: string, amount: number) => JSON.stringify({ timestamp, type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { total_tokens: amount },
      last_token_usage: { total_tokens: amount, input_tokens: amount - 1, output_tokens: 1 } },
  } });
  const writeAuth = (email: string, accountId: string) => {
    const claims = Buffer.from(JSON.stringify({ email })).toString('base64url');
    fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ tokens: {
      account_id: accountId, id_token: `header.${claims}.signature`,
    } }));
  };
  writeAuth('a@example.com', 'id-a');
  fs.writeFileSync(path.join(sessions, 'old.jsonl'), [meta(), token('2026-09-24T12:00:00Z', 10)].join('\n'));
  fs.writeFileSync(path.join(sessions, 'a.jsonl'), [meta('id-a'), token('2026-09-28T12:00:00Z', 20)].join('\n'));
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  t.after(() => raw.close());
  const db = new SQLiteDB(raw, path.join(root, 'usage.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT)');
  ensureCodexLocalUsageTables(db);
  const mismatched = createCodexLocalUsageService(db, { codexHome: root,
    readCurrentAccountId: async () => 'id-other',
    now: () => Date.parse('2026-09-29T12:00:00+08:00') });
  const mismatchedResult = await mismatched.getSnapshot('a@example.com');
  assert.equal(mismatchedResult.sourceMeta?.state, 'unavailable');
  assert.deepEqual(mismatchedResult.dailyUsageBuckets, []);
  assert.equal(db.all('SELECT * FROM codex_local_usage_events').length, 0);
  let clock = Date.parse('2026-09-29T12:00:00+08:00');
  const service = createCodexLocalUsageService(db, { codexHome: root, now: () => clock });
  const first = await service.getSnapshot('a@example.com');
  assert.equal(first.dailyUsageBuckets.length, 365);
  assert.deepEqual(first.dailyUsageBuckets[0], { startDate: '2025-09-30', tokens: 0 });
  assert.deepEqual(first.dailyUsageBuckets.at(-1), { startDate: '2026-09-29', tokens: 0 });
  assert.equal(first.dailyUsageBuckets.find((day) => day.startDate === '2026-09-24')?.tokens, 10);
  assert.equal(first.dailyUsageBuckets.find((day) => day.startDate === '2026-09-28')?.tokens, 20);
  assert.equal(first.backfill?.email, 'a@example.com');
  assert.equal(fs.existsSync(path.join(root, 'usage.db')), true);
  const persisted = new SQL.Database(fs.readFileSync(path.join(root, 'usage.db')));
  assert.equal(persisted.exec('SELECT COUNT(*) FROM codex_local_usage_events')[0].values[0][0], 2);
  assert.equal(persisted.exec('SELECT COUNT(*) FROM codex_local_usage_backfill')[0].values[0][0], 1);
  assert.equal(persisted.exec("SELECT completed_at FROM codex_local_usage_sync WHERE email = 'a@example.com'")[0].values[0][0], clock);
  persisted.close();

  clock = Date.parse('2026-10-02T12:00:00+08:00');
  fs.writeFileSync(path.join(sessions, 'later.jsonl'), [meta('id-a'), token('2026-10-02T01:00:00Z', 5)].join('\n'));
  const later = await service.getSnapshot('a@example.com');
  assert.deepEqual(later.dailyUsageBuckets[0], { startDate: '2025-10-03', tokens: 0 });
  assert.equal(later.dailyUsageBuckets.length, 365);
  assert.equal(later.dailyUsageBuckets.at(-1)?.startDate, '2026-10-02');
  assert.equal(later.dailyUsageBuckets.at(-1)?.tokens, 5);

  fs.writeFileSync(path.join(sessions, 'b.jsonl'), [meta('id-b'), token('2026-09-29T01:00:00Z', 30)].join('\n'));
  fs.writeFileSync(path.join(sessions, 'unknown.jsonl'), [meta(), token('2026-09-29T02:00:00Z', 40)].join('\n'));
  fs.writeFileSync(path.join(sessions, 'other.jsonl'), [meta('id-other'), token('2026-09-29T03:00:00Z', 50)].join('\n'));
  writeAuth('b@example.com', 'id-b');
  const second = await service.getSnapshot('b@example.com');
  assert.equal(second.dailyUsageBuckets.find((day) => day.startDate === '2026-09-29')?.tokens, 30);
  assert.equal(db.get('SELECT SUM(tokens) AS tokens FROM codex_local_usage_events WHERE email = ? AND day = ?', ['a@example.com', '2026-09-29'])?.tokens ?? 0, 0);
  assert.equal(db.all('SELECT * FROM codex_local_usage_events').length, 4);
  clock = Date.parse('2027-10-02T12:00:00+08:00');
  assert.equal((await service.getSnapshot('b@example.com')).dailyUsageBuckets.length, 365);
});

test('scan failure returns stored usage for the confirmed email with its last success time', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-local-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  t.after(() => raw.close());
  const db = new SQLiteDB(raw, path.join(root, 'usage.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT)');
  ensureCodexLocalUsageTables(db);
  db.run(`INSERT INTO codex_local_usage_events
    (fingerprint, day, email, creator_account_id, tokens, input_tokens, cached_input_tokens, output_tokens, attribution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['event-a', '2026-10-14', 'a@example.com', 'id-a', 17, 10, 0, 7, 'log_account']);
  db.run('INSERT INTO codex_local_usage_sync (email, completed_at) VALUES (?, ?)', ['a@example.com', 1000]);
  const attemptedAt = Date.parse('2026-10-14T12:00:00+08:00');
  const service = createCodexLocalUsageService(db, { codexHome: root, now: () => attemptedAt,
    readCurrentAccountId: async () => 'id-a', scanEvents: async () => { throw new Error('scan failed'); } });
  const result = await service.getSnapshot('a@example.com');
  assert.equal(result.sourceMeta?.state, 'failed_snapshot');
  assert.equal(result.sourceMeta?.lastSuccessAt, 1000);
  assert.equal(result.sourceMeta?.lastAttemptAt, attemptedAt);
  assert.equal(result.dailyUsageBuckets.find((day) => day.startDate === '2026-10-14')?.tokens, 17);
  assert.equal(result.email, 'a@example.com');
  assert.equal((await service.getSnapshot('b@example.com')).dailyUsageBuckets.length, 0);
});

test('first scan failure returns unavailable without fabricated zero buckets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-local-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  t.after(() => raw.close());
  const db = new SQLiteDB(raw, path.join(root, 'usage.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT)');
  ensureCodexLocalUsageTables(db);
  const service = createCodexLocalUsageService(db, { codexHome: root, now: () => 2000,
    readCurrentAccountId: async () => 'id-a', scanEvents: async () => { throw new Error('scan failed'); } });
  const result = await service.getSnapshot('a@example.com');
  assert.equal(result.sourceMeta?.state, 'unavailable');
  assert.deepEqual(result.dailyUsageBuckets, []);
});

test('failed disk save keeps the previous local usage and success time', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-local-save-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  t.after(() => raw.close());
  const db = new SQLiteDB(raw, path.join(root, 'usage.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT)');
  ensureCodexLocalUsageTables(db);
  db.run(`INSERT INTO codex_local_usage_events
    (fingerprint, day, email, creator_account_id, tokens, input_tokens, cached_input_tokens, output_tokens, attribution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['old', '2026-10-14', 'a@example.com', 'id-a', 17, 10, 0, 7, 'log_account']);
  db.run('INSERT INTO codex_local_usage_sync (email, completed_at) VALUES (?, ?)', ['a@example.com', 1000]);
  db.saveToFile();
  db.saveToFile = () => { throw new Error('disk write failed'); };
  const service = createCodexLocalUsageService(db, { codexHome: root,
    now: () => Date.parse('2026-10-15T12:00:00+08:00'), readCurrentAccountId: async () => 'id-a',
    scanEvents: async () => [{ fingerprint: 'new', day: '2026-10-15', accountId: 'id-a',
      tokens: 5, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2 }] });
  const result = await service.getSnapshot('a@example.com');
  assert.equal(result.sourceMeta?.state, 'failed_snapshot');
  assert.equal(result.sourceMeta?.lastSuccessAt, 1000);
  assert.equal(result.dailyUsageBuckets.find((day) => day.startDate === '2026-10-14')?.tokens, 17);
  assert.equal(result.dailyUsageBuckets.find((day) => day.startDate === '2026-10-15')?.tokens, 0);
});
