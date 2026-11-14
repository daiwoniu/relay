import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';

test('单条消息详情校验会话归属并只返回脱敏详情', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-details-route-'));
  process.env.RELAY_DB_PATH = path.join(directory, 'relay.db');
  try {
    const [{ initDB }, queries, { default: sessions }] = await Promise.all([
      import('../db/index.js'),
      import('../db/queries.js'),
      import('./sessions.js'),
    ]);
    const db = await initDB();
    const projectId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const otherSessionId = '33333333-3333-4333-8333-333333333333';
    const messageId = '44444444-4444-4444-8444-444444444444';
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    db.run('INSERT INTO projects (id, name, path, owner_user_id, created_at, updated_at, pinned, is_system) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [projectId, '项目', directory, userId, 1, 1, 0, 1]);
    for (const id of [sessionId, otherSessionId]) {
      db.run('INSERT INTO sessions (id, title, title_manually_set, created_at, updated_at, pinned, archived, project_id, owner_user_id, status, message_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, '会话', 0, 1, 1, 0, 0, projectId, userId, 'idle', 0]);
    }
    queries.saveMessage({
      id: messageId,
      session_id: sessionId,
      turn_id: 'turn-1',
      role: 'assistant',
      content: '完成',
      phase: 'final_answer',
      items: JSON.stringify([{
        id: 'item-1',
        type: 'commandExecution',
        status: 'completed',
        command: 'npm test',
        secret: '不得输出',
      }]),
      metadata: JSON.stringify({
        processContent: '处理过程',
        processTimeline: [{ type: 'narrative', itemId: 'narrative-1', content: '处理过程' }],
        changedFiles: [{ path: 'src/app.ts', changeType: 'modified' }],
      }),
      duration: null,
      stopped: 0,
    });

    const app = new Hono<RelayEnv>();
    app.use('*', async (c, next) => { c.set('relayActor', { userId, role: 'admin' }); return next(); });
    app.route('/api/sessions', sessions);
    const response = await app.request(`/api/sessions/${sessionId}/messages/${messageId}/details`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const details = await response.json() as any;
    assert.equal(details.sessionId, sessionId);
    assert.equal(details.messageId, messageId);
    assert.equal(details.items[0].details.command, 'npm test');
    assert.equal(Object.hasOwn(details.items[0].details, 'secret'), false);
    assert.equal(details.processContent, '处理过程');
    assert.equal(details.changedFiles[0].path, 'src/app.ts');
    assert.equal(Object.hasOwn(details, 'content'), false);

    const wrongSession = await app.request(`/api/sessions/${otherSessionId}/messages/${messageId}/details`);
    assert.equal(wrongSession.status, 404);
  } finally {
    delete process.env.RELAY_DB_PATH;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
