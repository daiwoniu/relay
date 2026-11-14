import assert from 'node:assert/strict';
import test from 'node:test';
import { isAssistantTerminalMessage } from './message-terminal.ts';

test('只有真实终态结束流式状态，新旧审批和用户消息都不结束', () => {
  const message = { role: 'assistant', phase: 'final_answer', content: '完整结论', outcome: 'completed' };
  assert.equal(isAssistantTerminalMessage(message), true);
  assert.equal(isAssistantTerminalMessage({ ...message, content: '  ' }), false);
  assert.equal(isAssistantTerminalMessage({ ...message, phase: 'interaction' }), false);
  assert.equal(isAssistantTerminalMessage({ ...message, role: 'user' }), false);
  for (const outcome of ['failed', 'stopped', 'interrupted']) {
    assert.equal(isAssistantTerminalMessage({ ...message, content: '', phase: 'error', outcome }), true);
  }
});
