import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleToolUse, TOOL_USE_MIN_MS } from './tools-usage.ts';

test('brief visits cancel without recording; a full visit counts exactly once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const close = scheduleToolUse(() => count++);
  t.mock.timers.tick(TOOL_USE_MIN_MS - 1);
  close();
  t.mock.timers.tick(10_000);
  assert.equal(count, 0);
  const closeLong = scheduleToolUse(() => count++);
  t.mock.timers.tick(TOOL_USE_MIN_MS);
  assert.equal(count, 1);
  t.mock.timers.tick(60_000);
  closeLong();
  assert.equal(count, 1);
});

test('switching tools cancels the old visit and starts an independent interval', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const visits = [];
  const cancel = scheduleToolUse(() => visits.push('calendar'));
  t.mock.timers.tick(2000);
  cancel();
  scheduleToolUse(() => visits.push('weather'));
  t.mock.timers.tick(4999);
  assert.deepEqual(visits, []);
  t.mock.timers.tick(1);
  assert.deepEqual(visits, ['weather']);
});
