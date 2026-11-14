import assert from 'node:assert/strict';
import test from 'node:test';
import { createPomodoro, diffLines, formatJson, parseZonedDateTime, readPomodoro, tickPomodoro, timestampMilliseconds } from './local-tools-model.ts';
import { createQrSvg } from './qr-code.ts';

test('timestamp conversion keeps epoch, negative dates and explicit units distinct', () => {
  assert.equal(timestampMilliseconds('0', 'seconds'), 0);
  assert.equal(timestampMilliseconds('-1', 'milliseconds'), -1);
  assert.equal(timestampMilliseconds('123', 'seconds'), 123000);
  for (const value of ['1.5', '', '1e9', '8640000000000001']) assert.throws(() => timestampMilliseconds(value, 'milliseconds'));
});

test('date conversion requires an explicit zone and rejects invalid calendar days', () => {
  assert.equal(parseZonedDateTime('1970-01-01T08:00:00+08:00'), 0);
  assert.equal(parseZonedDateTime('1970-01-01T00:00:00Z'), 0);
  assert.equal(parseZonedDateTime('2024-02-29T12:00:00-05:00'), Date.UTC(2024, 1, 29, 17));
  assert.equal(parseZonedDateTime('2024-07-01T12:00:00-04:00'), Date.UTC(2024, 6, 1, 16));
  for (const value of ['2026-02-29T00:00:00Z', '2026-11-31T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00', '2026-01-01T00:00:00+25:00']) assert.throws(() => parseZonedDateTime(value));
});

test('JSON formatting preserves numeric tokens, duplicate keys, escapes and whitespace in strings', () => {
  const source = '{"id":9223372036854775807,"value":-0,"huge":1e400,"message":" 空 格 ","escaped":"\\\"\\\\","empty":[],"empty":{}}';
  const formatted = formatJson(source);
  assert.ok(formatted.includes('9223372036854775807'));
  assert.ok(formatted.includes('"value": -0'));
  assert.ok(formatted.includes('1e400'));
  assert.equal(formatJson(formatted, true), source);
  assert.equal(formatJson('[]'), '[]');
  assert.equal(formatJson(' {"a": [1, {"b": true}]} ', true), '{"a":[1,{"b":true}]}');
  assert.throws(() => formatJson('{"a":}'));
  assert.throws(() => formatJson('['.repeat(101) + '0' + ']'.repeat(101)));
});

test('line diff reconstructs both inputs without treating HTML as markup', () => {
  for (const [a, b] of [['旧标题\n保留\n旧内容', '新标题\n保留\n新内容'], ['', 'hello'], ['hello', ''], ['a\na\nb', 'a\nb\na'], ['<script>\n米果', '<script>\n米豆'], ['a\n', 'a\nb\n']]) {
    const result = diffLines(a, b);
    assert.equal(result.filter((line) => line.kind !== 'add').map((line) => line.text).join('\n'), a);
    assert.equal(result.filter((line) => line.kind !== 'remove').map((line) => line.text).join('\n'), b);
  }
  assert.deepEqual(diffLines('a\r\nb', 'a\nb').map((line) => line.kind), ['same', 'same']);
  assert.throws(() => diffLines('a\n'.repeat(501), 'a'));
  assert.throws(() => diffLines('a'.repeat(50001), 'a'));
});

test('pomodoro catches up after background throttling and completes each focus once', () => {
  const initial = createPomodoro();
  const running = { ...initial, deadline: 1000 + initial.remainingMs };
  assert.equal(tickPomodoro(running, 61000).remainingMs, 24 * 60000);
  const finished = tickPomodoro(running, running.deadline + 100000);
  assert.equal(finished.remainingMs, 0); assert.equal(finished.deadline, null); assert.equal(finished.rounds, 1);
  assert.equal(tickPomodoro(finished, 999999999).rounds, 1);
  assert.equal(tickPomodoro(initial, 999999999), initial);
  assert.equal(tickPomodoro({ ...running, mode: 'break' }, running.deadline + 1).rounds, 0);
});

test('pomodoro resumes stored deadlines and discards corrupt settings', () => {
  const state = { ...createPomodoro(), remainingMs: 0, deadline: 1_000_000 };
  assert.equal(readPomodoro(JSON.stringify(state), 900_000).remainingMs, 100000);
  assert.equal(readPomodoro(JSON.stringify(state), 1_000_001).rounds, 1);
  assert.deepEqual(readPomodoro('{bad', 0), createPomodoro());
  assert.deepEqual(readPomodoro(JSON.stringify({ ...state, focusMinutes: -1 }), 0), createPomodoro());
});

test('QR generation creates a local SVG for Unicode without including raw text in markup', () => {
  const result = createQrSvg('祥哥 <script>alert(1)</script>');
  assert.ok(result.startsWith('<svg'));
  assert.ok(result.includes('http://www.w3.org/2000/svg'));
  assert.ok(!result.includes('<script>'));
  assert.throws(() => createQrSvg('  '));
  assert.throws(() => createQrSvg('米'.repeat(501)));
});
