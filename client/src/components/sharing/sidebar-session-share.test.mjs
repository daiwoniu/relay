import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('会话列表菜单只接入整个会话分享', () => {
  const source = fs.readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /onShareSession: \(\) => handleSessionShare\(menuSession\)/);
  assert.match(source, /scope: 'session'/);
  assert.match(source, /<ShareCreateDialog draft=\{shareDraft\}/);
  assert.doesNotMatch(source, /onSelectMessages:/);
});
