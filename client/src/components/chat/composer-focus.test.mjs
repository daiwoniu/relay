import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldFocusComposerOnDevice } from './composer-focus.ts';

test('桌面端明确输入意图都允许聚焦输入框', () => {
  for (const reason of ['session-opened', 'new-chat', 'search-closed', 'attachment-selected']) {
    assert.equal(shouldFocusComposerOnDevice(reason, false), true, reason);
  }
});

test('移动端只在明确开始新会话或选中附件时主动弹出键盘', () => {
  assert.equal(shouldFocusComposerOnDevice('new-chat', true), true);
  assert.equal(shouldFocusComposerOnDevice('attachment-selected', true), true);
  assert.equal(shouldFocusComposerOnDevice('session-opened', true), false);
  assert.equal(shouldFocusComposerOnDevice('search-closed', true), false);
});
