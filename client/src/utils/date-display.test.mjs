import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDate, formatDateTime, formatClockTime } from './date-display.ts';

test('long and short dates use padded hyphens and 24-hour time', () => {
  const at = Date.parse('2026-01-02T00:04:05.006Z'), options = { timeZone: 'UTC' };
  assert.equal(formatDate(at, options), '2026-01-02');
  assert.equal(formatDate(at, { ...options, short: true }), '01-02');
  assert.equal(formatDateTime(at, options), '2026-01-02 00:04');
  assert.equal(formatDateTime(at, { ...options, short: true, seconds: true }), '01-02 00:04:05');
  assert.equal(formatDateTime(at, { ...options, milliseconds: true }), '2026-01-02 00:04:05.006');
  assert.equal(formatClockTime(at, { ...options, seconds: true }), '00:04:05');
});

test('calendar dates do not move to a previous day in western time zones', () => {
  assert.equal(formatDate('2026-01-01', { timeZone: 'America/Los_Angeles' }), '2026-01-01');
  assert.equal(formatDate('2026-01-01', { short: true, timeZone: 'America/Los_Angeles' }), '01-01');
  assert.equal(formatDate('2024-02-29'), '2024-02-29');
  assert.equal(formatDate('2026-02-29'), '未记录');
  assert.equal(formatDate('2026-02-30'), '未记录');
});

test('timestamps preserve the requested time zone, year boundary and daylight saving time', () => {
  assert.equal(formatDateTime('2025-12-31T16:00:00Z', { timeZone: 'Asia/Shanghai', seconds: true }), '2026-01-01 00:00:00');
  assert.equal(formatDateTime('2026-03-08T06:59:00Z', { timeZone: 'America/New_York' }), '2026-03-08 01:59');
  assert.equal(formatDateTime('2026-03-08T07:00:00Z', { timeZone: 'America/New_York' }), '2026-03-08 03:00');
  assert.equal(formatDateTime(0, { timeZone: 'UTC' }), '1970-01-01 00:00');
});

test('invalid and missing values use explicit placeholders', () => {
  for (const value of [null, undefined, '', 'not-a-date', NaN, Infinity, new Date(NaN)]) {
    assert.equal(formatDate(value), '未记录');
    assert.equal(formatDateTime(value, { fallback: '系统未提供' }), '系统未提供');
    assert.equal(formatClockTime(value, { fallback: '未知' }), '未知');
  }
});
