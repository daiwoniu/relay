import assert from 'node:assert/strict';
import test from 'node:test';
import { presentProcessItem, parseMessageItems } from './presenter.js';
import { compactProcessItemsForStorage } from './storage.js';
import { upsertTurnItem } from '../ws/frontend-protocol.js';
import { sanitizeProcessItems } from '../shares/snapshot.js';

test('计划快照按 ID 替换，历史重复投影与分享保留步骤状态', () => {
  const first = { id: 'relay-plan:turn', type: 'plan', status: 'completed', plan: [
    { step: '读取', status: 'inProgress' }, { step: '验证', status: 'pending' },
  ] };
  const last = { ...first, explanation: '根据读取结果调整', plan: [{ step: '读取', status: 'completed' }, { step: '验证', status: 'inProgress' }] };
  const items = upsertTurnItem(upsertTurnItem([], first), last);
  assert.equal(items.length, 1);
  const stored = compactProcessItemsForStorage(items);
  const restored = parseMessageItems(JSON.stringify(stored));
  assert.deepEqual(restored?.[0].details.plan, last.plan);
  assert.equal(restored?.[0].details.explanation, last.explanation);
  assert.deepEqual(compactProcessItemsForStorage(stored), stored);
  assert.deepEqual(sanitizeProcessItems(restored)?.[0].details.plan, last.plan);
  assert.equal(sanitizeProcessItems(restored)?.[0].details.explanation, last.explanation);
});

test('计划仅接受有效步骤与状态，空计划可清空，旧数量仍能读取', () => {
  const item = presentProcessItem({ id: 'plan', type: 'plan', plan: [null, {},
    { step: 'bad', status: 'unknown' }, { step: '  ', status: 'pending' },
    { step: '检查', status: 'in_progress', secret: 'private' },
  ] });
  assert.deepEqual(item?.details, { plan: [{ step: '检查', status: 'inProgress' }], planCount: 1 });
  assert.deepEqual(presentProcessItem({ id: 'plan', type: 'plan', plan: [] })?.details, { plan: [], planCount: 0 });
  assert.deepEqual(presentProcessItem({ id: 'old', type: 'plan', details: { planCount: 3 } })?.details, { planCount: 3 });
  assert.deepEqual(presentProcessItem({ id: 'invalid', type: 'plan', plan: [], explanation: { secret: 'omit' } })?.details, { plan: [], planCount: 0 });
});
