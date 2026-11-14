import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';

test('项目与会话路由隔离普通成员并允许管理员完整管理', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-multi-account-routes-'));
  const previousPath = process.env.RELAY_DB_PATH;
  process.env.RELAY_DB_PATH = path.join(directory, 'relay.db');
  try {
    const [{ initDB }, { default: projectsRouter }, { default: sessionsRouter }] = await Promise.all([
      import('../db/index.js'),
      import('./projects.js'),
      import('./sessions.js'),
    ]);
    const db = await initDB();
    db.run(`INSERT INTO users
      (id, username, password_hash, role, display_name, created_at, updated_at)
      VALUES (?, ?, 'hash', ?, ?, 1, 1)`, ['admin', 'admin', 'admin', '管理员']);
    db.run(`INSERT INTO users
      (id, username, password_hash, role, display_name, created_at, updated_at)
      VALUES (?, ?, 'hash', ?, ?, 2, 2)`, ['member-a', 'member-a', 'member', '成员 A']);
    db.run(`INSERT INTO users
      (id, username, password_hash, role, display_name, created_at, updated_at)
      VALUES (?, ?, 'hash', ?, ?, 3, 3)`, ['member-b', 'member-b', 'member', '成员 B']);
    const sharedPath = directory;
    const normalized = sharedPath.toLocaleLowerCase('en-US');
    const adminProjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const memberAProjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    const memberBProjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
    for (const [id, owner, name, createdAt] of [
      [adminProjectId, 'admin', '管理员项目', 1],
      [memberAProjectId, 'member-a', '成员 A 项目', 2],
      [memberBProjectId, 'member-b', '成员 B 项目', 3],
    ] as const) {
      db.run(`INSERT INTO projects
        (id, name, path, normalized_path, owner_user_id, created_at, updated_at, pinned, is_system)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`, [id, name, sharedPath, normalized, owner, createdAt, createdAt]);
      db.run('UPDATE users SET default_project_id = ? WHERE id = ?', [id, owner]);
    }
    db.run(`INSERT INTO sessions
      (id, title, created_at, updated_at, pinned, archived, project_id, owner_user_id,
       engine, engine_bound, codex_archived, status)
      VALUES (?, '成员 B 会话', 4, 4, 0, 0, ?, 'member-b', 'codex', 1, 0, 'idle')`,
    ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', memberBProjectId]);

    const app = new Hono<RelayEnv>();
    app.use('*', async (c, next) => {
      const userId = c.req.header('x-test-user') || 'member-a';
      c.set('relayActor', { userId, role: userId === 'admin' ? 'admin' : 'member' });
      return next();
    });
    app.route('/projects', projectsRouter);
    app.route('/sessions', sessionsRouter);

    const memberProjects = await app.request('/projects', { headers: { 'x-test-user': 'member-a' } });
    assert.equal(memberProjects.status, 200);
    assert.deepEqual((await memberProjects.json() as Array<{ id: string }>).map((project) => project.id), [memberAProjectId]);

    const adminProjects = await app.request('/projects', { headers: { 'x-test-user': 'admin' } });
    assert.equal(adminProjects.status, 200);
    assert.equal((await adminProjects.json() as unknown[]).length, 3);

    const otherSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    assert.equal((await app.request(`/sessions/${otherSessionId}`, { headers: { 'x-test-user': 'member-a' } })).status, 404);
    assert.equal((await app.request(`/sessions/${otherSessionId}`, { headers: { 'x-test-user': 'admin' } })).status, 200);
    for (const endpoint of [
      `/sessions/${otherSessionId}/message-page`,
      `/sessions/${otherSessionId}/messages`,
      `/sessions/${otherSessionId}/messages/cccccccc-cccc-4ccc-8ccc-cccccccccccc/details`,
      `/sessions/${otherSessionId}/search-matches?q=test`,
    ]) {
      assert.equal((await app.request(endpoint, { headers: { 'x-test-user': 'member-a' } })).status, 404, endpoint);
    }

    const created = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'admin' },
      body: JSON.stringify({ projectId: memberBProjectId, engine: 'codex' }),
    });
    assert.equal(created.status, 201);
    const createdSession = await created.json() as { id: string; project_id: string; owner?: { id: string } };
    assert.equal(createdSession.project_id, adminProjectId);
    assert.equal(createdSession.owner?.id, 'admin');
    assert.equal(db.get('SELECT owner_user_id FROM sessions WHERE id = ?', [createdSession.id])?.owner_user_id, 'admin');
  } finally {
    if (previousPath === undefined) delete process.env.RELAY_DB_PATH;
    else process.env.RELAY_DB_PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
