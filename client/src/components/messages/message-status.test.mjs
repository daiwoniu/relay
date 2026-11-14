import assert from 'node:assert/strict';
import test from 'node:test';
import { getMessageStatusPresentation, shouldExpandProcessWithoutFinalReply } from './message-status.ts';

test('失败、用户中断和系统中断根据执行阶段生成不同文案', () => {
  assert.equal(getMessageStatusPresentation('failed', 'accepted').label, '启动失败');
  assert.equal(getMessageStatusPresentation('failed', 'responding').label, '执行失败');
  assert.equal(getMessageStatusPresentation('failed', 'responding', '未生成最终回复').label, '未生成最终回复');
  assert.equal(getMessageStatusPresentation('stopped', 'accepted').label, '已取消');
  assert.equal(getMessageStatusPresentation('stopped', 'started').label, '已停止');
  assert.equal(getMessageStatusPresentation('interrupted', 'accepted').label, '启动前中断');
  assert.equal(getMessageStatusPresentation('interrupted', 'responding').label, '意外中断');
});

test('运行态使用处理和停止语义色', () => {
  assert.deepEqual(getMessageStatusPresentation('processing', 'accepted', undefined, undefined, 'submitted'), {
    label: '消息发送中',
    tone: 'processing',
  });
  assert.deepEqual(getMessageStatusPresentation('processing', 'accepted', undefined, undefined, 'forwarded'), {
    label: '正在启动',
    tone: 'processing',
  });
  assert.deepEqual(getMessageStatusPresentation('processing', 'started'), {
    label: '处理中',
    tone: 'processing',
  });
  assert.deepEqual(getMessageStatusPresentation('recovering', 'started'), {
    label: '正在恢复',
    tone: 'processing',
  });
  assert.equal(getMessageStatusPresentation('stopping', 'started').tone, 'stopped');
  assert.deepEqual(getMessageStatusPresentation('awaiting_action', 'responding'), {
    label: '等待操作',
    tone: 'warning',
  });
});

test('初始化超时和授权取消使用友好说明并保留原始异常', () => {
  assert.deepEqual(
    getMessageStatusPresentation('failed', 'accepted', 'Codex 初始化失败: thread/start 请求超时（30000ms）', 'CODEX_INIT_FAILED'),
    {
      label: '新会话创建超时',
      tone: 'danger',
      detail: 'Codex 当前响应较慢，本条消息尚未开始处理。',
    },
  );
  assert.deepEqual(
    getMessageStatusPresentation('stopped', 'responding', 'Codex 回合已中断', 'CODEX_TURN_INTERRUPTED'),
    {
      label: '已取消',
      tone: 'stopped',
      detail: '你取消了待授权操作，本轮任务已结束。',
    },
  );
});

test('消息结束时有处理过程但没有最终回复则默认展开', () => {
  assert.equal(shouldExpandProcessWithoutFinalReply(false, true, ''), true);
  assert.equal(shouldExpandProcessWithoutFinalReply(false, true, '   '), true);
  assert.equal(shouldExpandProcessWithoutFinalReply(false, true, '最终回复'), false);
  assert.equal(shouldExpandProcessWithoutFinalReply(false, false, ''), false);
  assert.equal(shouldExpandProcessWithoutFinalReply(true, true, ''), false);
});
