import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectRecentSession } from './empty-state-shortcuts.ts';

test('recent shortcut chooses the latest nonempty, unarchived session without changing navigation order', () => {
  const sessions = [
    { id: 'older', updated_at: 10, codex_archived: false, message_count: 2 },
    { id: 'archived', updated_at: 40, codex_archived: true, message_count: 5 },
    { id: 'empty', updated_at: 30, codex_archived: false, message_count: 0 },
    { id: 'latest', updated_at: 20, codex_archived: false, message_count: 3 },
  ];

  assert.equal(selectRecentSession(sessions, null)?.id, 'latest');
  assert.deepEqual(sessions.map((session) => session.id), ['older', 'archived', 'empty', 'latest']);
});

test('recent shortcut hides when no other eligible session exists', () => {
  const sessions = [{ id: 'current', updated_at: 10, codex_archived: false, message_count: 1 }];
  assert.equal(selectRecentSession(sessions, 'current'), null);
  assert.equal(selectRecentSession([], null), null);
});

test('admin recent shortcut stays within the current owner account', () => {
  const sessions = [
    { id: 'other', updated_at: 20, codex_archived: false, message_count: 2, owner: { id: 'other-user' } },
    { id: 'mine', updated_at: 10, codex_archived: false, message_count: 2, owner: { id: 'me' } },
  ];
  assert.equal(selectRecentSession(sessions, null, 'me')?.id, 'mine');
});
