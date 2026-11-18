import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChinaDayPanelCache } from './china-day-panel-cache.js';

test('cache bounds distinct loads, coalesces duplicates and drains accepted loads before close', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cache-close-'));
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let loads = 0, fences = 0, closed = false;
  const cache = new ChinaDayPanelCache(root, () => 123, { maxPending: 1, assertExclusiveWriter: async () => { fences++; } });
  const load = async () => { loads++; started(); await gate; return { year: 2026, month: 10, days: [], warnings: [] }; };
  try {
    const first = cache.calendar(2026, 10, load), duplicate = cache.calendar(2026, 10, load);
    await entered;
    await assert.rejects(cache.calendar(2026, 11, load), /CACHE_BUSY/);
    const closing = cache.close().then(() => { closed = true; });
    await assert.rejects(cache.calendar(2026, 10, load), /CACHE_CLOSED/);
    await Promise.resolve(); assert.equal(closed, false);
    release(); assert.deepEqual(await first, await duplicate); await closing;
    assert.equal(loads, 1); assert.equal(fences, 2); assert.equal(closed, true);
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.part')), false);
    const reopened = new ChinaDayPanelCache(root, () => 123);
    assert.equal((await reopened.calendar(2026, 10, async () => { throw Error('unexpected reload'); })).fetchedAt, 123);
    await reopened.close();
  } finally { release(); await cache.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('lost write ownership leaves no cache payload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cache-fence-'));
  const cache = new ChinaDayPanelCache(root, Date.now, { assertExclusiveWriter: async () => { throw Error('OWNER_LOST'); } });
  try {
    await assert.rejects(cache.calendar(2026, 10, async () => ({ year: 2026, month: 10, days: [], warnings: [] })), /OWNER_LOST/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { await cache.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('calendar cache survives a new service instance and refresh replaces it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-calendar-cache-'));
  try {
    let now = 100_000;
    let loads = 0;
    const load = async () => { loads += 1; return { year: 2026, month: 10, days: [], warnings: [] }; };
    const first = new ChinaDayPanelCache(root, () => now);
    assert.equal((await first.calendar(2026, 10, load)).fetchedAt, 100_000);
    const second = new ChinaDayPanelCache(root, () => now);
    now += 89 * 24 * 60 * 60 * 1000;
    assert.equal((await second.calendar(2026, 10, load)).fetchedAt, 100_000);
    assert.equal(loads, 1);
    assert.equal((await second.calendar(2026, 10, load, true)).fetchedAt, now);
    assert.equal((await first.calendar(2026, 10, load)).fetchedAt, now);
    assert.equal(loads, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing holiday data expires after one day while complete data lasts 90 days', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-calendar-cache-'));
  try {
    let now = 100_000;
    let loads = 0;
    const cache = new ChinaDayPanelCache(root, () => now);
    const load = async () => ({ year: 2027, month: 1, days: [], warnings: loads++ === 0 ? ['2027 年放假安排暂不可用'] : [] });
    await cache.calendar(2027, 1, load);
    now += 24 * 60 * 60 * 1000;
    assert.deepEqual((await cache.calendar(2027, 1, load)).value.warnings, []);
    assert.equal(loads, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('weather cache is shared by city and date for five hours', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-weather-cache-'));
  try {
    let now = 100_000;
    let loads = 0;
    const load = async () => { loads += 1; return { date: loads === 3 ? '2026-10-16' : '2026-10-15', location: { city: '济宁', latitude: 35.4, longitude: 116.58 }, days: [], source: 'open-meteo' as const }; };
    const first = new ChinaDayPanelCache(root, () => now);
    await first.weather('济宁', '2026-10-15', load);
    const second = new ChinaDayPanelCache(root, () => now);
    now += 5 * 60 * 60 * 1000 - 1;
    assert.equal((await second.weather('济宁', '2026-10-15', load)).fetchedAt, 100_000);
    assert.equal(loads, 1);
    now += 1;
    assert.equal((await second.weather('济宁', '2026-10-15', load)).fetchedAt, now);
    assert.equal(loads, 2);
    assert.equal((await second.weather('济宁', '2026-10-16', load)).value.date, '2026-10-16');
    assert.equal(loads, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('API forecasts persist and refresh through the shared weather cache', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-api-weather-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const load = async () => { calls++; return { date: '2026-11-17', location: { city: '济宁', latitude: 35.4, longitude: 116.58 },
    days: [], source: 'open-meteo' as const }; };
  await new ChinaDayPanelCache(root).weather('济宁', '2026-11-17', load);
  const reopened = new ChinaDayPanelCache(root);
  assert.equal((await reopened.weather('济宁', '2026-11-17', load)).value.source, 'open-meteo');
  assert.equal(calls, 1);
  await reopened.weather('济宁', '2026-11-17', load, true);
  assert.equal(calls, 2);
});

test('hourly weather expires after ten minutes and never reuses the previous hour window', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hourly-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-12-31T23:25:00+08:00'), calls = 0;
  const cache = new ChinaDayPanelCache(root, () => now);
  const load = async () => {
    calls++;
    const start = Math.floor(now / 3_600_000) * 3_600_000;
    return { location: { city: '济宁', latitude: 35.4, longitude: 116.58 }, source: 'open-meteo' as const,
      hours: Array.from({ length: 24 }, (_, i) => ({ time: new Date(start + (i + 8) * 3_600_000).toISOString().slice(0, 16),
        temperatureC: 10, precipitationProbabilityPercent: 0, weatherCode: 0 })) };
  };
  await cache.hourly('济宁', load);
  now += 9 * 60_000; await cache.hourly('济宁', load); assert.equal(calls, 1);
  now += 60_000; await cache.hourly('济宁', load); assert.equal(calls, 2);
  now = Date.parse('2027-01-01T00:00:00+08:00');
  assert.equal((await cache.hourly('济宁', load)).value.hours[0].time, '2027-01-01T00:00');
  assert.equal(calls, 3);
  await cache.hourly('济宁', load, true); assert.equal(calls, 4);
});
