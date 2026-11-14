import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemResourceStatusService, parseTypeperfCommitMemory } from './resource-status.js';

test('Windows typeperf 输出只提取两项提交内存数值', () => {
  assert.deepEqual(parseTypeperfCommitMemory([
    '"(PDH-CSV 4.0)","\\\\HOST\\Memory\\Committed Bytes","\\\\HOST\\Memory\\Commit Limit"',
    '"08/27/2026 18:02:03.010","21448728576.000000","89899360256.000000"',
    'Exiting, please wait...',
  ].join('\n')), {
    committedBytes: 21_448_728_576,
    commitLimitBytes: 89_899_360_256,
  });
});

test('系统提交内存状态按 80% 和 90% 分级且不携带进程内部标识', async () => {
  const snapshots = [
    { committedBytes: 79, commitLimitBytes: 100 },
    { committedBytes: 80, commitLimitBytes: 100 },
    { committedBytes: 90, commitLimitBytes: 100 },
  ];
  let now = 1;
  const service = createSystemResourceStatusService({
    now: () => now,
    cacheTtlMs: 0,
    sample: async () => snapshots.shift()!,
    sampleProcesses: async () => { throw new Error('unavailable'); },
  });

  const normal = await service.getSnapshot();
  now += 1;
  const warning = await service.getSnapshot();
  now += 1;
  const critical = await service.getSnapshot();

  assert.equal(normal.level, 'normal');
  assert.equal(warning.level, 'warning');
  assert.equal(critical.level, 'critical');
  assert.equal(critical.usagePercent, 90);
  assert.equal(critical.processMemory, null);
  assert.doesNotMatch(JSON.stringify(critical), /pid|command|path/i);
});

test('采集失败安全降级且短缓存避免重复启动系统探针', async () => {
  let now = 10_000;
  let calls = 0;
  const service = createSystemResourceStatusService({
    now: () => now,
    cacheTtlMs: 30_000,
    sampleProcesses: async () => { throw new Error('unavailable'); },
    sample: async () => {
      calls += 1;
      if (calls === 1) return { committedBytes: 25, commitLimitBytes: 100 };
      throw new Error('sensitive failure');
    },
  });

  assert.equal((await service.getSnapshot()).available, true);
  now += 1_000;
  assert.equal((await service.getSnapshot()).available, true);
  assert.equal(calls, 1);
  now += 30_000;
  const unavailable = await service.getSnapshot();
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.level, 'unknown');
  assert.equal(unavailable.committedBytes, null);
  assert.doesNotMatch(JSON.stringify(unavailable), /sensitive failure/);
});

test('进程和系统采集独立降级，并发请求复用同次采样及缓存', async () => {
  let calls = 0;
  let processCalls = 0;
  const memory = { relay: null, topProcesses: [{ name: 'app.exe', privateBytes: 100, processCount: 1 }] };
  const service = createSystemResourceStatusService({
    sample: async () => { calls += 1; throw new Error('commit failed'); },
    sampleProcesses: async () => { processCalls += 1; return memory; },
  });
  const [first, second] = await Promise.all([service.getSnapshot(), service.getSnapshot()]);
  assert.equal(first, second);
  assert.equal(first.available, false);
  assert.deepEqual(first.processMemory, memory);
  await service.getSnapshot();
  assert.equal(calls, 1);
  assert.equal(processCalls, 1);
});
