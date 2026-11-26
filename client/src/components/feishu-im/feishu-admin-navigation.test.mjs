import assert from 'node:assert/strict';
import test from 'node:test';
import { readFeishuConversationPosition, requestedFeishuAdminView, saveFeishuConversationPosition } from './feishu-admin-navigation.ts';

test('explicit tabs and old Feishu links take precedence over the default', () => {
  const view = query => requestedFeishuAdminView(new URLSearchParams(query));
  assert.equal(view(''), undefined);
  assert.equal(view('view=matters&matter=abc'), 'messages');
  assert.equal(view('chat=group'), 'messages');
  assert.equal(view('view=settings&chat=group'), 'settings');
  assert.equal(view('view=stats&matter=abc'), 'stats');
});

test('remembered Feishu conversations are scoped and restore the cursor for older pages', () => {
  const rows = new Map();
  const storage = { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) };
  const position = { key: 'group/native:session', sequence: 32, cursors: [100, 70] };
  saveFeishuConversationPosition(storage, 'bot-a', position);
  assert.deepEqual(readFeishuConversationPosition(storage, 'bot-a'), position);
  assert.equal(readFeishuConversationPosition(storage, 'bot-b'), null);
  assert.equal(readFeishuConversationPosition({ getItem: () => '{bad' }, 'bot-a'), null);
});
