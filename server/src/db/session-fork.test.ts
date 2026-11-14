import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from './queries.js';
import { createForkedSessionInDatabase } from './queries.js';

const source: Session = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '来源',
  title_manually_set: 1,
  created_at: 1,
  updated_at: 2,
  pinned: 0,
  archived: 0,
  project_id: '22222222-2222-4222-8222-222222222222',
  engine: 'codex',
  engine_bound: 1,
  engine_session_id: 'thread-source',
  engine_metadata: null,
  codex_thread_id: 'thread-source',
  codex_archived: 0,
  status: 'completed',
  token_usage: null,
  active_turn_usage: null,
};

test('分支事务写盘失败后补偿内存中的会话和消息', () => {
  const operations: string[] = [];
  let saveCount = 0;
  const db = {
    exec: (sql: string) => operations.push(sql),
    run: (sql: string) => operations.push(sql),
    get: (sql: string) => {
      operations.push(sql);
      if (sql.startsWith('SELECT updated_at')) return { updated_at: 100, message_revision: 0 };
      return undefined;
    },
    saveToFile: () => {
      saveCount += 1;
      if (saveCount === 1) throw new Error('disk full');
    },
  };

  assert.throws(() => createForkedSessionInDatabase(db, {
    id: '33333333-3333-4333-8333-333333333333',
    title: '来源（分支）',
    source,
    threadId: 'thread-fork',
    now: 100,
    messages: [{
      id: '44444444-4444-4444-8444-444444444444',
      session_id: '33333333-3333-4333-8333-333333333333',
      turn_id: 'turn-1',
      role: 'assistant',
      content: '完成',
      phase: null,
      items: null,
      metadata: '{"outcome":"completed"}',
    }],
  }), /disk full/);

  assert.equal(saveCount, 2);
  assert.equal(operations.filter((operation) => operation === 'BEGIN').length, 2);
  assert.equal(operations.filter((operation) => operation === 'COMMIT').length, 2);
  assert.ok(operations.some((operation) => operation.startsWith('DELETE FROM messages')));
  assert.ok(operations.some((operation) => operation.startsWith('DELETE FROM sessions')));
});
