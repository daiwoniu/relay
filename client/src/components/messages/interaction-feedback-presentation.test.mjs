import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [panel, form, approval, blank, assistant, refresh, styles, assistantStyles] = await Promise.all([
  readFile(new URL('./InteractionPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./McpElicitationForm.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../authorization/ApprovalDetails.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./BlankProcessingStatus.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./LatestMessageRefreshBubble.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../styles/message-ui.css', import.meta.url), 'utf8'),
  readFile(new URL('../../styles/assistant-messages.css', import.meta.url), 'utf8'),
]);

test('待处理与已处理交互共享标题、正文、操作和结果摘要结构', () => {
  assert.match(panel, /interaction-card--\$\{pending \? 'pending' : 'resolved'\}/);
  assert.match(panel, /interaction-card__header/);
  assert.match(panel, /interaction-card__body/);
  assert.match(panel, /interaction-card__actions/);
  assert.match(panel, /interaction-card__result/);
});

test('用户提问、MCP 与授权详情复用表单和长内容语义', () => {
  assert.match(panel, /interaction-form interaction-form--user-input/);
  assert.match(form, /interaction-form interaction-form--mcp/);
  assert.match(form, /interaction-field/);
  assert.match(approval, /approval-details/);
  assert.match(approval, /approval-details__code/);
});

test('错误、延迟处理和刷新状态使用统一反馈语义', () => {
  assert.match(assistant, /message-feedback message-feedback--error/);
  assert.match(blank, /message-inline-feedback message-inline-feedback--delayed/);
  assert.match(refresh, /message-inline-feedback message-inline-feedback--refresh/);
  assert.match(styles, /\.interaction-card--pending\s*\{[\s\S]*?notice-attention/);
  assert.match(styles, /\.interaction-card--resolved\s*\{[\s\S]*?border-light/);
  assert.match(styles, /\.message-feedback--error\s*\{[\s\S]*?status-danger/);
  assert.match(styles, /\.interaction-action\s*\{[\s\S]*?min-height:/);
  assert.match(assistantStyles, /\.assistant-message__detail\.message-feedback--error\s*\{[\s\S]*?status-danger/);
});

test('重新同步与重新加载使用同一轻量反馈操作样式', () => {
  assert.match(blank, /className="message-inline-feedback__action"/);
  assert.match(refresh, /className="message-inline-feedback__action mt-2"/);
  assert.doesNotMatch(blank, /message-inline-feedback__action[^"\n]*\bborder\b/);
  assert.doesNotMatch(refresh, /message-inline-feedback__action[^"\n]*\bborder\b/);
  assert.match(styles, /\.message-inline-feedback__action\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent/);
  assert.match(styles, /\.message-inline-feedback__action:hover:not\(:disabled\),[\s\S]*?\.message-inline-feedback__action:focus-visible/);
});

test('历史详情加载与失败重试复用轻量反馈操作', () => {
  assert.match(assistant, /message-inline-feedback message-inline-feedback--details/);
  assert.match(assistant, /className="message-inline-feedback__action/);
  assert.doesNotMatch(assistant, /加载失败，点击重试[\s\S]*?hover:underline/);
});

test('只读会话不会把待处理交互误报为当前可操作', () => {
  assert.match(panel, /onRespond \? '等待操作' : '等待会话端处理'/);
});

test('减少动态效果时停止消息流动画', () => {
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.streaming-cursor-inline[\s\S]*?animation:\s*none/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.process-timeline \.animate-spin[\s\S]*?animation:\s*none/);
});

test('禁用操作区分普通不可提交与正在提交', () => {
  assert.match(panel, /aria-busy=\{submitting\}/);
  assert.match(styles, /\.interaction-action:disabled\s*\{[\s\S]*?cursor:\s*not-allowed/);
  assert.match(styles, /\.interaction-card\[aria-busy=['"]true['"]\] \.interaction-action:disabled\s*\{[\s\S]*?cursor:\s*wait/);
});
