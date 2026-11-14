import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';

test('消息游标页返回 summary、revision、unchanged 和稳定历史游标', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-page-route-'));
  const databasePath = path.join(directory, 'relay.db');
  process.env.RELAY_DB_PATH = databasePath;
  try {
    const [{ initDB }, queries, { default: sessions }] = await Promise.all([
      import('../db/index.js'),
      import('../db/queries.js'),
      import('./sessions.js'),
    ]);
    const db = await initDB();
    const projectId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    db.run('INSERT INTO projects (id, name, path, owner_user_id, created_at, updated_at, pinned, is_system) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [projectId, '项目', directory, userId, 1, 1, 0, 1]);
    db.run('INSERT INTO sessions (id, title, title_manually_set, created_at, updated_at, pinned, archived, project_id, owner_user_id, status, message_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [sessionId, '会话', 0, 1, 1, 0, 0, projectId, userId, 'idle', 0]);
    for (let index = 1; index <= 4; index += 1) {
      queries.saveMessage({
        id: `33333333-3333-4333-8333-33333333333${index}`,
        session_id: sessionId,
        turn_id: `turn-${index}`,
        role: 'assistant',
        content: `消息${index}`,
        phase: 'final_answer',
        items: index === 4 ? JSON.stringify([{ id: 'item-1', type: 'reasoning', status: 'completed', content: '分析' }]) : null,
        metadata: index === 4 ? JSON.stringify({ processContent: '过程', changedFiles: [{ path: 'src/app.ts', changeType: 'modified' }] }) : null,
        duration: null,
        stopped: 0,
      });
    }
    const app = new Hono<RelayEnv>();
    app.use('*', async (c, next) => { c.set('relayActor', { userId, role: 'admin' }); return next(); });
    app.route('/api/sessions', sessions);
    const latestResponse = await app.request(`/api/sessions/${sessionId}/message-page?limit=2`);
    assert.equal(latestResponse.status, 200);
    const latest = await latestResponse.json() as any;
    assert.equal(latest.unchanged, false);
    assert.equal(latest.page.revision, 4);
    assert.equal(latest.page.hasMore, true);
    assert.equal(latest.page.messages.length, 2);
    assert.equal(latest.page.messages.at(-1).hasDetails, true);
    assert.equal(latest.page.messages.at(-1).processItemCount, 1);
    assert.equal(Object.hasOwn(latest.page.messages.at(-1), 'items'), false);

    const unchanged = await (await app.request(`/api/sessions/${sessionId}/message-page?knownRevision=4`)).json() as any;
    assert.deepEqual(unchanged, { unchanged: true, revision: 4 });

    const cursor = latest.page.nextCursor;
    const older = await (await app.request(`/api/sessions/${sessionId}/message-page?limit=2&beforeCreatedAt=${cursor.beforeCreatedAt}&beforeId=${cursor.beforeId}&knownRevision=4`)).json() as any;
    assert.equal(older.unchanged, false);
    assert.equal(older.page.messages.length, 2);
    assert.equal(older.page.hasMore, false);
    assert.equal(older.page.nextCursor, null);
  } finally {
    delete process.env.RELAY_DB_PATH;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
