import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnauthenticatedApiRequest } from '../auth/public-paths.js';
import { PublicShareRateLimiter } from '../shares/public-rate-limit.js';
import { createPublicSharesRouter } from './public-shares.js';

const token = 'a'.repeat(64);

test('只有公开分享 GET 可以绕过用户 Cookie 登录保护', () => {
  assert.equal(isUnauthenticatedApiRequest('GET', `/api/public/shares/${token}`), true);
  assert.equal(isUnauthenticatedApiRequest('POST', `/api/public/shares/${token}`), false);
  assert.equal(isUnauthenticatedApiRequest('GET', '/api/shares'), false);
});

test('公开读取无需 Cookie，返回只读快照和安全响应头', async () => {
  const router = createPublicSharesRouter({
    service: { readPublic: () => ({
      state: 'active', title: '公开分享', messageCount: 1, createdAt: 1, expiresAt: null,
      snapshot: { version: 1, messages: [{ id: 'message-1', role: 'assistant', content: '内容', createdAt: 1, outcome: 'completed' }] },
    }) },
    limiter: new PublicShareRateLimiter(10),
    getClientId: () => 'client-1',
    isOriginAllowed: () => true,
  });
  const response = await router.request(`http://localhost/${token}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { state: string }).state, 'active');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, noarchive');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('无效令牌、未知分享和限流响应不包含消息数据', async () => {
  const limiter = new PublicShareRateLimiter(1, 60_000);
  const router = createPublicSharesRouter({
    service: { readPublic: () => ({ state: 'not_found' }) }, limiter, getClientId: () => 'client-1',
    isOriginAllowed: () => true,
  });
  const invalid = await router.request('http://localhost/not-a-token');
  assert.equal(invalid.status, 404);
  assert.equal(JSON.stringify(await invalid.json()).includes('messages'), false);
  const missing = await router.request(`http://localhost/${token}`);
  assert.equal(missing.status, 404);
  assert.equal(JSON.stringify(await missing.json()).includes('messages'), false);
  const limited = await router.request(`http://localhost/${token}`);
  assert.equal(limited.status, 429);
  assert.equal(JSON.stringify(await limited.json()).includes('messages'), false);
});

test('公开分享读取拒绝白名单外 Origin', async () => {
  const router = createPublicSharesRouter({
    service: { readPublic: () => ({ state: 'not_found' }) },
    limiter: new PublicShareRateLimiter(),
    getClientId: () => 'client-1',
    isOriginAllowed: (origin) => origin !== 'https://evil.example',
  });
  const response = await router.request(`http://localhost/${token}`, { headers: { origin: 'https://evil.example' } });
  assert.equal(response.status, 403);
});
