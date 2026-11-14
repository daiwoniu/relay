import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateShareRequestSchema } from '../contracts/index.js';
import {
  SHARE_CUSTOM_MAX_MS,
  SHARE_CUSTOM_MIN_MS,
  getShareManagementStatus,
  resolveShareExpiry,
  validateShareSelection,
} from './model.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';

function parse(input: unknown) {
  return CreateShareRequestSchema.parse(input);
}

test('创建请求支持单条、多选和整会话范围', () => {
  const single = parse({ sessionId, scope: 'single', messageIds: [messageId], title: '单条', includeProcess: false, expiry: { type: 'preset', value: '1d' } });
  const selection = parse({ sessionId, scope: 'selection', messageIds: [messageId], title: '多选', includeProcess: true, expiry: { type: 'permanent' } });
  const session = parse({ sessionId, scope: 'session', title: '整会话', includeProcess: false, expiry: { type: 'preset', value: '7d' } });
  assert.equal(validateShareSelection(single), undefined);
  assert.equal(validateShareSelection(selection), undefined);
  assert.equal(validateShareSelection(session), undefined);
});

test('单条和多选范围校验消息数量', () => {
  const single = parse({ sessionId, scope: 'single', messageIds: [], title: '单条', includeProcess: false, expiry: { type: 'preset', value: '1d' } });
  const selection = parse({ sessionId, scope: 'selection', messageIds: [], title: '多选', includeProcess: false, expiry: { type: 'preset', value: '1d' } });
  assert.match(validateShareSelection(single) || '', /只能选择一条/);
  assert.match(validateShareSelection(selection) || '', /至少需要选择一条/);
});

test('有效期支持预设、自定义边界和永久', () => {
  const now = 1_000_000;
  assert.equal(resolveShareExpiry({ type: 'preset', value: '1h' }, now), now + 3_600_000);
  assert.equal(resolveShareExpiry({ type: 'preset', value: '1d' }, now), now + 86_400_000);
  assert.equal(resolveShareExpiry({ type: 'custom', expiresAt: now + SHARE_CUSTOM_MIN_MS }, now), now + SHARE_CUSTOM_MIN_MS);
  assert.equal(resolveShareExpiry({ type: 'custom', expiresAt: now + SHARE_CUSTOM_MAX_MS }, now), now + SHARE_CUSTOM_MAX_MS);
  assert.equal(resolveShareExpiry({ type: 'permanent' }, now), null);
  assert.throws(() => resolveShareExpiry({ type: 'custom', expiresAt: now + SHARE_CUSTOM_MIN_MS - 1 }, now), /10 分钟/);
  assert.throws(() => resolveShareExpiry({ type: 'custom', expiresAt: now + SHARE_CUSTOM_MAX_MS + 1 }, now), /90 天/);
});

test('标题和消息 ID 数量有明确上限', () => {
  const base = { sessionId, scope: 'selection', includeProcess: false, expiry: { type: 'preset', value: '1d' } } as const;
  assert.equal(CreateShareRequestSchema.safeParse({ ...base, title: '', messageIds: [messageId] }).success, false);
  assert.equal(CreateShareRequestSchema.safeParse({ ...base, title: 'x'.repeat(121), messageIds: [messageId] }).success, false);
  assert.equal(CreateShareRequestSchema.safeParse({ ...base, title: '正常', messageIds: Array.from({ length: 201 }, () => messageId) }).success, false);
});

test('管理状态不依赖可漂移的数据库状态列', () => {
  assert.equal(getShareManagementStatus({ expiresAt: null, revokedAt: null }, 100), 'active');
  assert.equal(getShareManagementStatus({ expiresAt: 99, revokedAt: null }, 100), 'expired');
  assert.equal(getShareManagementStatus({ expiresAt: 200, revokedAt: 50 }, 100), 'revoked');
});
