import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('运行中输入仍能发送，停止操作保留独立入口', async () => {
  const [input, submit] = await Promise.all([
    readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ChatInputSubmitControl.tsx', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(input, /\|\| isStreaming \|\| isQueued \|\| isSubmitting/);
  assert.match(submit, /if \(isStreaming\)[\s\S]*\{sendControl\}/);
});

test('后续消息展示只使用服务端状态', async () => {
  const [view, hook, status] = await Promise.all([
    readFile(new URL('./ChatView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../hooks/useRelayWebSocket.ts', import.meta.url), 'utf8'),
    readFile(new URL('./SessionFollowupStatus.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(hook, /session_followup_snapshot/);
  assert.match(hook, /session_followup_updated/);
  assert.match(view, /<SessionFollowupStatus/);
  assert.match(view, /if \(!isRunningFollowup\) addMessage\(targetSessionId/);
  assert.match(view, /hasBlockingFollowups\(followupsBySession\[targetSessionId\]\)/);
  assert.match(hook, /hasBlockingFollowups\(useSessionFollowupStore\.getState\(\)\.bySession\[sessionId\]\)/);
  assert.match(status, /steered: '已加入当前任务'/);
  assert.match(status, /item\.state !== 'steered'/);
  assert.match(status, /uncertain: '交付结果不确定/);
  assert.match(status, /canCancelFollowup\(item\.state\)/);
  assert.match(status, /aria-label=\{item\.state === 'uncertain' \? '核对后移除此消息' : '取消并删除待发送消息'\}/);
  assert.match(status, /onCancel\(item\.id\)/);
  assert.doesNotMatch(status, />取消排队<|>核对后取消此消息</);
});
