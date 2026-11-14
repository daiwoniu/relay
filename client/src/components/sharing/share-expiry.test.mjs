import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShareExpiry, getShareStatusLabel, SHARE_EXPIRY_OPTIONS } from './share-expiry.ts';

test('有效期选项包含预设、自定义和永久', () => {
  assert.deepEqual(SHARE_EXPIRY_OPTIONS.map((option) => option.value), ['1h', '1d', '7d', '30d', 'custom', 'permanent']);
  assert.deepEqual(buildShareExpiry('1d', '', 1000), { type: 'preset', value: '1d' });
  assert.deepEqual(buildShareExpiry('permanent', '', 1000), { type: 'permanent' });
});

test('自定义有效期限制在十分钟至九十天', () => {
  const now = Date.UTC(2026, 7, 6);
  assert.deepEqual(buildShareExpiry('custom', new Date(now + 600_000).toISOString(), now), { type: 'custom', expiresAt: now + 600_000 });
  assert.throws(() => buildShareExpiry('custom', new Date(now + 599_999).toISOString(), now), /10 分钟/);
});

test('管理状态展示永久、临期、过期和取消', () => {
  assert.equal(getShareStatusLabel('active', null, 1000), '永久有效');
  assert.equal(getShareStatusLabel('active', 2000, 1000), '即将过期');
  assert.equal(getShareStatusLabel('expired', 500, 1000), '已过期');
  assert.equal(getShareStatusLabel('revoked', null, 1000), '已取消');
});
