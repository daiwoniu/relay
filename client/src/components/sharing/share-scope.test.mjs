import assert from 'node:assert/strict';
import test from 'node:test';
import { getShareScopePresentation } from './share-scope.ts';

test('三种分享范围使用完整且明确的名称', () => {
  assert.deepEqual(getShareScopePresentation('single'), { label: '单条消息', description: '仅公开当前选中的一条消息' });
  assert.deepEqual(getShareScopePresentation('selection'), { label: '所选消息', description: '仅公开本次选择的多条消息' });
  assert.deepEqual(getShareScopePresentation('selection', 3), { label: '所选消息', description: '仅公开本次选择的 3 条消息' });
  assert.deepEqual(getShareScopePresentation('session'), { label: '整个会话', description: '公开截至最后一条已完成回复的会话内容' });
});
