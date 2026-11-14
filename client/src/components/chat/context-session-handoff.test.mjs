import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_SESSION_HANDOFF_REQUEST,
  buildContextSessionContinuationDraft,
  findContextSessionHandoffSummary,
  hasContextSessionHandoffDraftConflict,
} from './context-session-handoff.ts';

const message = (role, content, extra = {}) => ({ role, content, ...extra });

test('提供固定且自包含的交接摘要请求', () => {
  assert.match(CONTEXT_SESSION_HANDOFF_REQUEST, /优先控制在 800 个中文字符以内/);
  assert.match(CONTEXT_SESSION_HANDOFF_REQUEST, /可放宽至 1200 个中文字符/);
  assert.match(CONTEXT_SESSION_HANDOFF_REQUEST, /目标、已完成、关键决策、修改文件、验证结果、未完成事项、下一步/);
  assert.match(CONTEXT_SESSION_HANDOFF_REQUEST, /不为凑齐字段重复信息/);
  assert.match(CONTEXT_SESSION_HANDOFF_REQUEST, /只输出交接摘要，不要继续执行任务/);
});

test('最近的交接请求和 assistant 回复组成可续开的摘要', () => {
  assert.equal(findContextSessionHandoffSummary([
    message('user', '先处理任务'),
    message('assistant', '处理中'),
    message('user', CONTEXT_SESSION_HANDOFF_REQUEST),
    message('assistant', '  目标：继续优化\n下一步：实现续聊  '),
  ]), '目标：继续优化\n下一步：实现续聊');
});

test('摘要后继续产生消息则旧摘要失效', () => {
  assert.equal(findContextSessionHandoffSummary([
    message('user', CONTEXT_SESSION_HANDOFF_REQUEST),
    message('assistant', '交接摘要'),
    message('user', '再改一项'),
  ]), null);
});

test('识别时忽略 system 消息', () => {
  assert.equal(findContextSessionHandoffSummary([
    message('user', CONTEXT_SESSION_HANDOFF_REQUEST),
    message('system', '内部状态'),
    message('assistant', '交接摘要'),
    message('system', ''),
  ]), '交接摘要');
});

test('失败、停止或中断的 assistant 回复不能作为交接摘要', () => {
  for (const response of [
    message('assistant', '失败回复', { isError: true }),
    message('assistant', '停止回复', { stopped: true }),
    message('assistant', '失败回复', { outcome: 'failed' }),
    message('assistant', '停止回复', { outcome: 'stopped' }),
    message('assistant', '中断回复', { outcome: 'interrupted' }),
  ]) {
    assert.equal(findContextSessionHandoffSummary([
      message('user', CONTEXT_SESSION_HANDOFF_REQUEST),
      response,
    ]), null);
  }
});

test('成功完成或缺少旧版 outcome 的正常回复可作为交接摘要', () => {
  assert.equal(findContextSessionHandoffSummary([
    message('user', CONTEXT_SESSION_HANDOFF_REQUEST),
    message('assistant', '新消息摘要', { outcome: 'completed' }),
  ]), '新消息摘要');
  assert.equal(findContextSessionHandoffSummary([
    message('user', CONTEXT_SESSION_HANDOFF_REQUEST),
    message('assistant', '旧消息摘要'),
  ]), '旧消息摘要');
});

test('摘要后的纯附件消息也会使旧摘要失效', () => {
  assert.equal(findContextSessionHandoffSummary([
    message('user', CONTEXT_SESSION_HANDOFF_REQUEST),
    message('assistant', '交接摘要'),
    message('user', '', { attachments: [{ id: 'attachment-1' }] }),
  ]), null);
});

test('不会把普通 assistant 回复误判成交接摘要', () => {
  assert.equal(findContextSessionHandoffSummary([
    message('user', '继续'),
    message('assistant', '已经完成'),
  ]), null);
});

test('构建新会话草稿并拒绝空摘要', () => {
  assert.equal(buildContextSessionContinuationDraft('  目标：继续优化  '), [
    '请继续处理上一会话的任务。以下是交接摘要，请先核查仓库实际状态，再从“下一步”继续，不要重复已完成工作。',
    '',
    '--- 交接摘要 ---',
    '目标：继续优化',
  ].join('\n'));
  assert.equal(buildContextSessionContinuationDraft('   '), null);
});

test('目标新会话存在文字或附件草稿时阻止覆盖', () => {
  assert.equal(hasContextSessionHandoffDraftConflict('已有草稿', 0), true);
  assert.equal(hasContextSessionHandoffDraftConflict('   ', 1), true);
  assert.equal(hasContextSessionHandoffDraftConflict('   ', 0), false);
});
