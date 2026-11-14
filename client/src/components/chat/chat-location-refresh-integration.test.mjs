import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const sidebar = readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');
const sessionsApi = readFileSync(new URL('../../api/sessions.ts', import.meta.url), 'utf8');
const projectsApi = readFileSync(new URL('../../api/projects.ts', import.meta.url), 'utf8');
const chatView = [
  './ChatView.tsx',
  './ChatViewPresentation.tsx',
].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const chatStore = readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');
const navigationLoader = readFileSync(new URL('../layout/sidebar-navigation-loader.ts', import.meta.url), 'utf8');

test('位置恢复请求支持超时、主动取消和错误重试', () => {
  assert.match(sessionsApi, /listSessions\(signal\?: AbortSignal/);
  assert.match(projectsApi, /listProjects\(signal\?: AbortSignal/);
  assert.match(sidebar, /const controller = new AbortController\(\)/);
  assert.match(navigationLoader, /listSessions\(signal\)/);
  assert.match(navigationLoader, /listProjects\(signal\)/);
  assert.match(sidebar, /controller\.abort\(\)/);
  assert.match(sidebar, /navigationReloadVersion/);
  assert.match(sidebar, /<SidebarLoadingState/);
  assert.match(sidebar, /setNavigationReloadVersion\(\(version\) => version \+ 1\)/);
  assert.match(sidebar, /currentActiveSessionId === candidateAtStart \? storedLocation : readStoredChatLocation\(\)/);
  assert.match(sidebar, /useRef\(readUrlSessionChatLocation\(\)\)/);
  assert.match(sidebar, /loadSidebarNavigation\(controller\.signal, urlSessionLocation\)/);
  assert.match(navigationLoader, /getSession\(urlSessionLocation\.sessionId/);
  assert.match(navigationLoader, /error\.status === 403 \|\| error\.status === 404/);
  assert.match(sidebar, /resolveInitialChatLocation\(/);
  assert.match(sidebar, /urlSessionLocationRef\.current = null/);
  assert.match(chatStore, /const initialChatCandidate = getInitialChatCandidate\(\)/);
  assert.match(chatStore, /restoreStoredChatCandidate:[\s\S]*?getInitialChatCandidate\(\)/);
  assert.match(chatView, /navigationLoadState\.status !== 'loading'/);
  assert.match(chatView, /chatInitializationState === 'message_error'/);
  assert.doesNotMatch(chatView, /retryChatLocation/);
});
