import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const assistant = readFileSync(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');
const list = readFileSync(new URL('../chat/MessageList.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../styles/message-ui.css', import.meta.url), 'utf8');

test('已完成 assistant 消息操作栏提供从此处新建会话按钮', () => {
  assert.match(assistant, /label: forkPending \? '正在新建会话' : '从此处新建会话'/);
  assert.match(assistant, /disabled: forkPending/);
  assert.match(assistant, /<MessageActionsMenu items=\{messageActionItems\} mobile=\{mobile\} \/>/);
  assert.match(list, /msg\.role|<AssistantMessage/);
  assert.match(list, /msg\.outcome === 'completed'/);
  assert.match(list, /onForkMessage\(msg\.id\)/);
  assert.match(styles, /\.message-action-button\s*\{[\s\S]*?min-width:\s*2rem;[\s\S]*?min-height:\s*2rem;/);
});

test('无正文但可新建会话的 assistant 消息仍显示更多入口', () => {
  assert.match(assistant, /const showMessageActions = messageActionItems\.length > 0/);
  assert.match(assistant, /\{showMessageActions && <div/);
  assert.doesNotMatch(assistant, /\{\(displayContent \|\| \(processContent/);
});

test('只读分享只保留直接复制且不生成更多操作菜单项', () => {
  assert.match(assistant, /if \(mobile && !readOnly && displayContent\)/);
  assert.match(assistant, /if \(!readOnly && displayContent\)[\s\S]*?key: 'source'/);
  assert.match(assistant, /const showDirectCopy = Boolean\(displayContent\) && \(!mobile \|\| readOnly\)/);
  assert.match(assistant, /\{showDirectCopy && \(/);
});
