import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityDecision } from './capacity.js';

test('剩余空间低于 256 MiB 或两倍目标分片时暂停采集', () => {
  const mib = 1024 * 1024;
  assert.equal(capacityDecision(255 * mib, 10 * mib).allowed, false);
  assert.equal(capacityDecision(300 * mib, 200 * mib).allowed, false);
  assert.equal(capacityDecision(500 * mib, 200 * mib).allowed, true);
});
