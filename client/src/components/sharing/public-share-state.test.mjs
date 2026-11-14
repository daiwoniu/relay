import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../../api/client.ts';
import { getPublicShareStateMessage, resolvePublicShareError, resolvePublicShareViewState } from './public-share-state.ts';

test('公开分享状态覆盖加载、有效、过期、取消、未知和损坏', () => {
  assert.equal(resolvePublicShareViewState({ state: 'expired' }).type, 'expired');
  assert.equal(resolvePublicShareViewState({ state: 'revoked' }).type, 'revoked');
  assert.equal(resolvePublicShareViewState({ state: 'not_found' }).type, 'not_found');
  assert.equal(resolvePublicShareViewState({ state: 'unreadable' }).type, 'unreadable');
  assert.match(getPublicShareStateMessage('expired'), /过期/);
});

test('公开读取错误区分限流、未知和一般错误', () => {
  assert.equal(resolvePublicShareError(new ApiError(429, { error: '请求过于频繁' })).type, 'rate_limited');
  assert.equal(resolvePublicShareError(new ApiError(404, null)).type, 'not_found');
  assert.equal(resolvePublicShareError(new Error('network')).type, 'error');
});
