import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});

const { useChatStore } = await import('./chat.ts');

test('账号资源范围由 Sidebar 与 ChatView 共享并在认证状态重置时回到我的', () => {
  useChatStore.getState().setSidebarAccountScope('all');
  assert.equal(useChatStore.getState().sidebarAccountScope, 'all');

  useChatStore.getState().resetAuthenticatedChatState();
  assert.equal(useChatStore.getState().sidebarAccountScope, 'mine');
});
