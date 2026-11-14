import assert from 'node:assert/strict';
import test from 'node:test';
import { getDisplayedSessionStatus, getSessionStatusPresentation, getSidebarSessionStatus, getSessionDisplayStage } from './session-status.ts';

test('会话状态提供稳定的显示语义', () => {
  assert.deepEqual(getSessionStatusPresentation('queued'), { label: '等待执行', tone: 'stopped' });
  assert.deepEqual(getSessionStatusPresentation('pending'), { label: '正在启动', tone: 'processing' });
assert.deepEqual(getSessionStatusPresentation('processing'), { label: '处理中', tone: 'processing' });
assert.deepEqual(getSessionStatusPresentation('recovering'), { label: '正在恢复', tone: 'processing' });
  assert.deepEqual(getSessionStatusPresentation('awaiting_action'), { label: '等待操作', tone: 'warning' });
  assert.deepEqual(getSessionStatusPresentation('stopping'), { label: '正在停止', tone: 'stopping' });
  assert.deepEqual(getSessionStatusPresentation('completed'), { label: '已完成', tone: 'success' });
  assert.deepEqual(getSessionStatusPresentation('failed'), { label: '执行失败', tone: 'danger' });
  assert.deepEqual(getSessionStatusPresentation('stopped'), { label: '已停止', tone: 'stopped' });
  assert.deepEqual(getSessionStatusPresentation('interrupted'), { label: '意外中断', tone: 'interrupted' });
  assert.deepEqual(getSessionStatusPresentation(undefined), { label: '空闲', tone: 'none' });
});

test('选中与归档不覆盖真实执行状态', () => {
  assert.equal(getDisplayedSessionStatus('queued', true), 'queued');
  assert.equal(getDisplayedSessionStatus('pending', true), 'pending');
assert.equal(getDisplayedSessionStatus('processing', true), 'processing');
assert.equal(getDisplayedSessionStatus('recovering', true), 'recovering');
  assert.equal(getDisplayedSessionStatus('awaiting_action', true), 'awaiting_action');
  assert.equal(getDisplayedSessionStatus('stopping', true), 'stopping');
  assert.equal(getDisplayedSessionStatus('completed', true), 'completed');
  assert.equal(getDisplayedSessionStatus('failed', true), 'failed');
  assert.equal(getDisplayedSessionStatus('completed', false), 'completed');
  assert.equal(getDisplayedSessionStatus('idle', true, true), 'idle');
  assert.equal(getDisplayedSessionStatus('processing', false, true), 'processing');
});

test('只有当前结果已读才能收起成功和主动停止，异常仍保留', () => {
  for (const status of ['completed', 'stopped']) {
    const session = { status, last_result: { messageId: 'result-2' } };
    assert.equal(getSidebarSessionStatus(session, 'result-1'), status);
    assert.equal(getSidebarSessionStatus(session, 'result-2'), 'idle');
  }
  for (const status of ['failed', 'interrupted', 'processing', 'awaiting_action']) {
    assert.equal(getSidebarSessionStatus({ status, last_result: { messageId: 'result-2' } }, 'result-2'), status);
  }
});

test('等待交互展示结合请求类型和操作权限', () => {
  assert.equal(getSessionStatusPresentation('awaiting_action', 'approval').label, '待授权');
  assert.equal(getSessionStatusPresentation('awaiting_action', 'input').label, '待回答');
  assert.equal(getSessionStatusPresentation('awaiting_action', 'mixed').label, '等待操作');
  assert.equal(getSessionStatusPresentation('awaiting_action', 'approval', false).label, '等待会话所有人处理');
});

test('未启动时使用取消与启动失败文案', () => {
  assert.equal(getSessionStatusPresentation('stopped', null, true, 'accepted').label, '已取消');
  assert.equal(getSessionStatusPresentation('stopping', null, true, 'accepted').label, '正在取消');
  assert.equal(getSessionStatusPresentation('failed', null, true, 'accepted').label, '启动失败');
});

test('终态采用本轮保存阶段，不能沿用旧运行态阶段', () => {
  const result = { messageId: 'result-2', status: 'failed', executionStage: 'responding' };
  assert.equal(getSessionDisplayStage({ status: 'failed', execution_stage: 'accepted', last_result: result }), 'responding');
  assert.equal(getSessionDisplayStage({ status: 'stopped', execution_stage: 'responding', last_result: { ...result, status: 'stopped', executionStage: 'accepted' } }), 'accepted');
  assert.equal(getSessionDisplayStage({ status: 'failed', execution_stage: 'accepted' }), undefined);
  assert.equal(getSessionDisplayStage({ status: 'processing', execution_stage: 'started', last_result: result }), 'started');
});
