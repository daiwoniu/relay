import test from 'node:test';
import assert from 'node:assert/strict';
import { recordProcessTiming } from './process-timing.js';
import { compactProcessItemsForStorage } from './storage.js';
import { parseMessageItems, presentProcessItem } from './presenter.js';
import type { RuntimeTurnItem } from '../engine/runtime.js';

test('首次观察和首次完成保持稳定，更新不能重写时间或把晚到start当真实起点', () => {
  const runtime = { engine: 'codex' as const, turnItems: [] as RuntimeTurnItem[] };
  const initial = recordProcessTiming(runtime, { id: 'a', type: 'fileChange', status: 'in_progress', path: 'a.ts' }, 100, 'start');
  runtime.turnItems = [initial];
  const completed = recordProcessTiming(runtime, { id: 'a', type: 'fileChange', status: 'completed', details: { path: 'a.ts', firstObservedAt: 1 } }, 200, 'complete');
  assert.equal((completed.details as any).firstObservedAt, 100);
  assert.equal((completed.details as any).startedObservedAt, 100);
  assert.equal((completed.details as any).completedObservedAt, 200);
  runtime.turnItems = [completed];
  assert.equal((recordProcessTiming(runtime, completed, 300, 'complete').details as any).completedObservedAt, 200);
  const completeOnly = recordProcessTiming({ ...runtime, turnItems: [] }, completed, 400, 'complete');
  const lateStart = recordProcessTiming({ ...runtime, turnItems: [completeOnly] }, initial, 500, 'start');
  assert.equal((lateStart.details as any).startedObservedAt, undefined);
  assert.equal((lateStart.details as any).firstObservedAt, 400);
});

test('时间元数据经展示白名单与文件压缩后仍可读回，非法时间不输出', () => {
  const item = recordProcessTiming({ engine: 'codex', turnItems: [] }, { id: 'a', type: 'fileChange', status: 'completed', details: { path: 'a.ts' } }, 100, 'instant');
  const stored = compactProcessItemsForStorage([item]);
  const restored = parseMessageItems(JSON.stringify(stored))![0]!;
  assert.equal(restored.details.firstObservedAt, 100); assert.equal(restored.details.completedObservedAt, 100);
  assert.equal(restored.details.startedObservedAt, undefined);
  const invalid = presentProcessItem({ id: 'x', type: 'plan', firstObservedAt: -1, completedObservedAt: Infinity });
  assert.equal(invalid!.details.firstObservedAt, undefined); assert.equal(invalid!.details.completedObservedAt, undefined);
});

test('非Codex与非法观察时间不扩展事件，也不读取客户端当前时间', () => {
  const item = { id: 'x', type: 'plan', status: 'completed' };
  assert.equal(recordProcessTiming({ engine: 'codebuddy', turnItems: [] }, item, 100, 'instant'), item);
  assert.equal(recordProcessTiming({ engine: 'codex', turnItems: [] }, item, NaN, 'instant'), item);
});
