import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectRecentSessions } from './empty-state-shortcuts.ts';

test('returns at most two nonempty, unarchived sessions in update order without reordering the source', () => {
  const sessions = [
    { id: 'older', updated_at: 10, codex_archived: false, message_count: 2 },
    { id: 'archived', updated_at: 50, codex_archived: true, message_count: 5 },
    { id: 'empty', updated_at: 40, codex_archived: false, message_count: 0 },
    { id: 'latest', updated_at: 30, codex_archived: false, message_count: 3 },
    { id: 'second', updated_at: 20, codex_archived: false, message_count: 1 },
  ];

  assert.deepEqual(selectRecentSessions(sessions, null).map(session => session.id), ['latest', 'second']);
  assert.deepEqual(selectRecentSessions(sessions, '').map(session => session.id), ['latest', 'second']);
  assert.deepEqual(sessions.map(session => session.id), ['older', 'archived', 'empty', 'latest', 'second']);
});

test('hides shortcuts inside an existing empty session and when there is no eligible history', () => {
  const sessions = [
    { id: 'current', updated_at: 10, message_count: 0 },
    { id: 'other', updated_at: 5, message_count: 1 },
  ];
  assert.deepEqual(selectRecentSessions(sessions, 'current'), []);
  assert.deepEqual(selectRecentSessions([{ id: 'unknown', updated_at: 1 }], null), []);
  assert.deepEqual(selectRecentSessions([], null), []);
});

test('admin shortcuts show only their own eligible sessions, including when only one qualifies', () => {
  const sessions = [
    { id: 'other', updated_at: 20, message_count: 2, owner: { id: 'other-user' } },
    { id: 'mine', updated_at: 10, message_count: 2, owner: { id: 'me' } },
  ];
  assert.deepEqual(selectRecentSessions(sessions, null, 'me').map(session => session.id), ['mine']);
});
