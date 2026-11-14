import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_INPUT_HISTORY_LIMIT,
  getChatInputHistoryNavigation,
  getRecentChatInputHistory,
  shouldSendMessageOnKeyDown,
} from './chat-input-keyboard.ts';

const enter = { key: 'Enter', shiftKey: false, isComposing: false };

test('桌面端 Enter 发送消息', () => {
  assert.equal(shouldSendMessageOnKeyDown(enter, {
    isMobile: false,
    isStreaming: false,
  }), true);
});

test('桌面端 Shift+Enter 保留为换行', () => {
  assert.equal(shouldSendMessageOnKeyDown({ ...enter, shiftKey: true }, {
    isMobile: false,
    isStreaming: false,
  }), false);
});

test('移动端 Enter 和 Shift+Enter 都保留为换行', () => {
  assert.equal(shouldSendMessageOnKeyDown(enter, {
    isMobile: true,
    isStreaming: false,
  }), false);
  assert.equal(shouldSendMessageOnKeyDown({ ...enter, shiftKey: true }, {
    isMobile: true,
    isStreaming: false,
  }), false);
});

test('输入法组合输入不发送，生成中仍可按 Enter 发送', () => {
  assert.equal(shouldSendMessageOnKeyDown({ ...enter, isComposing: true }, {
    isMobile: false,
    isStreaming: false,
  }), false);
  assert.equal(shouldSendMessageOnKeyDown(enter, {
    isMobile: false,
    isStreaming: true,
  }), true);
});

const arrow = (key) => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
});

const historyContext = (overrides = {}) => ({
  isMobile: false,
  value: '',
  selectionStart: 0,
  selectionEnd: 0,
  history: ['第一条', '第二条'],
  historyIndex: null,
  draft: '',
  ...overrides,
});

test('桌面端空输入框按上键召回最近发送内容', () => {
  assert.deepEqual(getChatInputHistoryNavigation(arrow('ArrowUp'), historyContext()), {
    value: '第二条',
    historyIndex: 1,
    draft: '',
    caret: 3,
  });
});

test('非空草稿只在光标到达边界后进入历史，并可向下恢复草稿', () => {
  assert.equal(getChatInputHistoryNavigation(arrow('ArrowUp'), historyContext({
    value: '未发送\n草稿', selectionStart: 4, selectionEnd: 4,
  })), null);

  const recalled = getChatInputHistoryNavigation(arrow('ArrowUp'), historyContext({
    value: '未发送\n草稿', selectionStart: 0, selectionEnd: 0,
  }));
  assert.deepEqual(recalled, {
    value: '第二条',
    historyIndex: 1,
    draft: '未发送\n草稿',
    caret: 3,
  });
  assert.deepEqual(getChatInputHistoryNavigation(arrow('ArrowDown'), historyContext({
    value: recalled.value,
    selectionStart: recalled.value.length,
    selectionEnd: recalled.value.length,
    historyIndex: recalled.historyIndex,
    draft: recalled.draft,
  })), {
    value: '未发送\n草稿',
    historyIndex: null,
    draft: '未发送\n草稿',
    caret: 6,
  });
});

test('历史内容按上下键依次切换，首尾不循环', () => {
  assert.deepEqual(getChatInputHistoryNavigation(arrow('ArrowUp'), historyContext({
    value: '第二条', selectionStart: 0, selectionEnd: 0, historyIndex: 1, draft: '草稿',
  })), {
    value: '第一条', historyIndex: 0, draft: '草稿', caret: 3,
  });
  assert.equal(getChatInputHistoryNavigation(arrow('ArrowUp'), historyContext({
    value: '第一条', selectionStart: 0, selectionEnd: 0, historyIndex: 0, draft: '草稿',
  })), null);
  assert.deepEqual(getChatInputHistoryNavigation(arrow('ArrowDown'), historyContext({
    value: '第一条', selectionStart: 3, selectionEnd: 3, historyIndex: 0, draft: '草稿',
  })), {
    value: '第二条', historyIndex: 1, draft: '草稿', caret: 3,
  });
});

test('移动端、组合输入、修饰键和文本选择不接管历史导航', () => {
  assert.equal(getChatInputHistoryNavigation(arrow('ArrowUp'), historyContext({ isMobile: true })), null);
  assert.equal(getChatInputHistoryNavigation({ ...arrow('ArrowUp'), isComposing: true }, historyContext()), null);
  assert.equal(getChatInputHistoryNavigation({ ...arrow('ArrowUp'), ctrlKey: true }, historyContext()), null);
  assert.equal(getChatInputHistoryNavigation(arrow('ArrowUp'), historyContext({ selectionEnd: 1 })), null);
});

test('输入历史只保留当前已加载消息中最近 20 条非空用户内容', () => {
  const messages = Array.from({ length: CHAT_INPUT_HISTORY_LIMIT + 5 }, (_, index) => ([
    { role: 'user', content: `用户-${index}` },
    { role: 'assistant', content: `回复-${index}` },
  ])).flat();
  messages.push({ role: 'user', content: '' });

  const history = getRecentChatInputHistory(messages);
  assert.equal(history.length, 20);
  assert.equal(history[0], '用户-5');
  assert.equal(history.at(-1), '用户-24');
});

test('输入历史合并相邻的重复内容', () => {
  const messages = [
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '继续' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '完成' },
    { role: 'user', content: '下一步' },
    { role: 'user', content: '继续' },
  ];

  assert.deepEqual(getRecentChatInputHistory(messages), ['继续', '下一步', '继续']);
});
