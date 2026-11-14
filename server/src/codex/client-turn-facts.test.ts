import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPlanUpdate, presentWarningNotification } from './client-turn-facts.js';

test('计划快照拒绝非活动回合和无效输入，保留空计划以清空旧清单', () => {
  assert.equal(extractPlanUpdate({ turnId: 'old', plan: [] }, 'current', 'root'), null);
  assert.equal(extractPlanUpdate({ turnId: 'current', plan: [] }, null, 'root'), null);
  assert.equal(extractPlanUpdate({ turnId: 'current', plan: {} }, 'current', 'root'), null);
  assert.deepEqual(extractPlanUpdate({ turnId: 'current', plan: [] }, 'current', 'root'), {
    type: 'item_complete', threadId: 'root', turnId: 'current',
    item: { id: 'relay-plan:current', type: 'plan', status: 'completed', plan: [], explanation: '' },
  });
  const explained = extractPlanUpdate({
    turnId: 'current', explanation: '  根据检查结果调整  ', plan: [{ step: '验证', status: 'pending' }],
  }, 'current', 'root');
  assert.equal(explained?.type, 'item_complete');
  if (!explained || explained.type !== 'item_complete') throw new Error('缺少计划更新事件');
  assert.deepEqual(explained.item, {
    id: 'relay-plan:current', type: 'plan', status: 'completed',
    explanation: '根据检查结果调整', plan: [{ step: '验证', status: 'pending' }],
  });
  const cleared = extractPlanUpdate({
    turnId: 'current', plan: [{ step: '验证', status: 'completed' }],
  }, 'current', 'root');
  assert.equal(cleared?.type, 'item_complete');
  if (!cleared || cleared.type !== 'item_complete') throw new Error('缺少计划清理事件');
  assert.equal(cleared.item.explanation, '');
});

test('四类警告转换保持语义、默认值和展示字段', () => {
  for (const [method, noticeType, title] of [
    ['warning', 'warning', '运行提示'], ['guardianWarning', 'guardian_warning', '安全警告'],
  ]) {
    assert.deepEqual(presentWarningNotification(method, { message: 1, secret: 'omit' }), {
      type: 'system_notice', noticeType, title, message: undefined,
    });
  }
  for (const [method, noticeType] of [['configWarning', 'config_warning'], ['deprecationNotice', 'deprecation']]) {
    assert.deepEqual(presentWarningNotification(method, { summary: '配置', details: '详情', path: 'config', range: 3 }), {
      type: 'system_notice', noticeType, title: '配置', message: '详情', details: { path: 'config', range: 3 },
    });
  }
});
