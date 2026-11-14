import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicShareRateLimiter } from './public-rate-limit.js';

test('公开分享按客户端与令牌组合限流并在窗口后恢复', () => {
  const limiter = new PublicShareRateLimiter(2, 1000, 10);
  assert.equal(limiter.consume('client:token', 0), true);
  assert.equal(limiter.consume('client:token', 1), true);
  assert.equal(limiter.consume('client:token', 2), false);
  assert.equal(limiter.consume('other:token', 2), true);
  assert.equal(limiter.consume('client:token', 1000), true);
});
