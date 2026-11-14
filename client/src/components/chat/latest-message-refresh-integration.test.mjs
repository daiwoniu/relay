import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const chatView = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');
const messageList = readFileSync(new URL('./MessageList.tsx', import.meta.url), 'utf8');
const chatStore = readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');
const sessionsApi = readFileSync(new URL('../../api/sessions.ts', import.meta.url), 'utf8');
const refreshBubble = readFileSync(new URL('../messages/LatestMessageRefreshBubble.tsx', import.meta.url), 'utf8');

test('消息最新页请求显式绕过浏览器缓存', () => {
  assert.match(sessionsApi, /cache:\s*'no-store'/);
});

test('页面恢复、网络恢复和重复打开当前会话都会重新校准', () => {
  assert.match(chatView, /document\.addEventListener\('visibilitychange'/);
  assert.match(chatView, /window\.addEventListener\('pageshow'/);
  assert.match(chatView, /window\.addEventListener\('online'/);
  assert.match(chatView, /shouldRefreshOnPageShow\(event\.persisted\)/);
  assert.match(chatView, /activeSessionOpenVersion/);
  assert.match(chatStore, /activeSessionOpenVersion:\s*state\.activeSessionOpenVersion \+ 1/);
});

test('消息刷新会取消过期请求并使用轻量游标页校准', () => {
  assert.match(chatView, /const controller = new AbortController\(\)/);
  assert.match(chatView, /controller\.abort\(\)/);
  assert.match(chatView, /loadMessageRegion\(\{/);
  assert.match(chatView, /getMessagePage\(sessionId/);
  assert.doesNotMatch(chatView, /details:\s*'full'/);
});

test('消息列表仅在缓存尾部缺少回复且非运行态时展示最新消息占位气泡', () => {
  assert.match(chatView, /isLatestMessageReplyMissing\(currentMessages\)/);
  assert.match(messageList, /LatestMessageRefreshBubble/);
  assert.match(messageList, /latestMessagesRefreshStatus !== 'idle' && !runningMessage\.show/);
  assert.match(refreshBubble, /正在加载最新消息…/);
  assert.match(refreshBubble, /暂时无法加载最新消息/);
  assert.match(refreshBubble, /aria-live="polite"/);
  assert.match(refreshBubble, /重新加载/);
});
