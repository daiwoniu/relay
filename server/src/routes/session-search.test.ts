import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import sessionsRouter from './sessions.js';

test('会话搜索路由在动态会话路由前注册并调用搜索服务', () => {
  const source = fs.readFileSync(new URL('sessions.ts', import.meta.url), 'utf8');
  const searchRoute = source.indexOf("sessions.get('/search'");
  const dynamicRoute = source.indexOf("sessions.get('/:id'");

  assert.ok(searchRoute >= 0);
  assert.ok(dynamicRoute >= 0);
  assert.ok(searchRoute < dynamicRoute);
  assert.match(source, /sessionService\.searchForActor\(/);
  assert.match(source, /sessions\.get\('\/:id\/search-matches'/);
  assert.match(source, /sessionService\.searchMessages\(/);
  assert.match(source, /includeProcess: c\.req\.query\('includeProcess'\) === '1'/);
  assert.match(source, /includeOperations: c\.req\.query\('includeOperations'\) === '1'/);
});

test('会话搜索接口拒绝空查询和超长查询', async () => {
  const empty = await sessionsRouter.request('http://localhost/search?q=');
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: '搜索词长度必须为 1–100 个字符' });

  const tooLong = await sessionsRouter.request(`http://localhost/search?q=${'x'.repeat(101)}`);
  assert.equal(tooLong.status, 400);

  const emptyMatches = await sessionsRouter.request('http://localhost/session-1/search-matches?q=');
  assert.equal(emptyMatches.status, 400);
});
