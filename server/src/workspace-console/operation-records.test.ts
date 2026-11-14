import assert from 'node:assert/strict';
import test from 'node:test';
import type { Actor } from '../auth/authorization.js';
import { OperationRecordsService } from './operation-records.js';

const admin = { userId: 'admin', role: 'admin' } as Actor;
const anchor = '2026-10-16T07:45:34.000Z';
const now = Date.parse('2026-10-17T00:00:00.000Z');

test('coalesces one detail read, caches it, and keeps raw changes out of the response', async () => {
  const calls: string[][] = [];
  const service = new OperationRecordsService(async (args) => {
    calls.push(args);
    const at = Date.parse('2026-10-14T07:03:24.728Z');
    return { events: [{ at, module: 'sub_task_mod', operation: 'complete', childId: '9001000031', property: null },
      { at, module: 'field_mod', operation: 'modify', childId: null, property: null },
      { at, module: 'sub_task_mod', operation: 'complete', childId: '9001000031', property: null }],
    hasMore: false, cursor: null };
  }, () => now, 0);
  const [first, second] = await Promise.all([
    service.get(admin, '9001000029', anchor), service.get(admin, '9001000029', anchor),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.events, [
    { at: '2026-10-14T07:03:24.728Z', childId: '9001000031', label: '完成子任务' },
    { at: '2026-10-14T07:03:24.728Z', childId: null, label: '修改工作项字段' },
  ]);
  assert.equal((await service.get(admin, '9001000029', anchor)).events.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.includes('--start'), true);
  assert.equal(calls[0]?.includes('--end'), true);
  await service.get(admin, '9001000029', anchor, null, true);
  assert.equal(calls.length, 2);
});

test('pagination remains a separate bounded request and invalid callers never reach Project', async () => {
  const calls: string[][] = [];
  const service = new OperationRecordsService(async (args) => {
    calls.push(args);
    return { events: [], hasMore: false, cursor: null };
  }, () => now, 0);
  await service.get(admin, '9001000029', anchor, 'cursor_1');
  assert.deepEqual(calls[0]?.slice(-2), ['--cursor', 'cursor_1']);
  await assert.rejects(service.get({ userId: 'member', role: 'member' } as Actor, '9001000029', anchor));
  await assert.rejects(service.get(admin, '../wrong', anchor));
  await assert.rejects(service.get(admin, '9001000029', anchor, 'bad?cursor'));
  assert.equal(calls.length, 1);
});

test('limits distinct Project history reads to two concurrent requests', async () => {
  let active = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const service = new OperationRecordsService(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return { events: [], hasMore: false, cursor: null };
  }, () => now, 0);
  const reads = ['9001000029', '9001000027', '9001000006'].map((id) => service.get(admin, id, anchor));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(active, 2);
  releases.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(maximum, 2);
  assert.equal(active, 2);
  releases.splice(0).forEach((release) => release());
  await Promise.all(reads);
});
