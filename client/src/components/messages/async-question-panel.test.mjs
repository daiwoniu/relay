import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Codex 提问卡运行时可提交并显示服务端回答交付状态', async () => {
  const [view, panel, steps] = await Promise.all([
    readFile(new URL('../chat/ChatView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./AsyncQuestionPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ProcessSteps.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(view, /canAnswerAsyncQuestion: true/);
  assert.doesNotMatch(view, /当前任务结束后可回答/);
  assert.match(view, /handleSend\(answer, \[\], generateUUID\(\), undefined, undefined, questionId\)/);
  assert.match(panel, /replyToAsyncQuestionId === step\.id/);
  assert.match(panel, /queued: '等待下一轮'/);
  assert.match(panel, /uncertain: '交付结果不确定'/);
  assert.match(steps, /<AsyncQuestionPanel/);
  assert.match(panel, /const closed = details.resolvedAction === 'cancel'/);
  assert.doesNotMatch(panel, /localStorage|dismissedKey/);
  assert.match(panel, /await onRespond!\(step.id, 'cancel'\)/);
  assert.match(panel, /result.outcome !== 'accepted'/);
  assert.match(panel, /所有设备关闭，不再提醒/);
  assert.match(steps, /onRespond=\{onInteractionRespond/);
});
