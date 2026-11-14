import assert from 'node:assert/strict';
import test from 'node:test';
import { getSharePagination, presentShareManagementItem, SHARE_PAGE_SIZE } from './share-management.ts';

const base = { id: '1', publicToken: 'token', title: '分享', scope: 'session', messageCount: 2, includeProcess: false, sourceSessionId: 's1', sourceSessionTitle: '来源', createdAt: 1, expiresAt: 5000, revokedAt: null };

test('分享管理状态决定来源文案与允许操作', () => {
  assert.deepEqual(presentShareManagementItem({ ...base, status: 'active' }, 1000), { statusLabel: '即将过期', sourceLabel: '来源', canRevoke: true, canDelete: false });
  assert.equal(presentShareManagementItem({ ...base, status: 'active', expiresAt: null }, 1000).statusLabel, '永久有效');
  assert.deepEqual(presentShareManagementItem({ ...base, status: 'expired', sourceSessionId: null, sourceSessionTitle: null }, 6000), { statusLabel: '已过期', sourceLabel: '来源已删除', canRevoke: false, canDelete: true });
  assert.equal(presentShareManagementItem({ ...base, status: 'revoked', revokedAt: 2000 }, 3000).canDelete, true);
});

test('分享管理分页计算偏移和边界', () => {
  assert.deepEqual(getSharePagination(0, 0), {
    page: 0, pageCount: 1, offset: 0, start: 0, end: 0, hasPrevious: false, hasNext: false,
  });
  assert.deepEqual(getSharePagination(SHARE_PAGE_SIZE * 2 + 1, 1), {
    page: 1, pageCount: 3, offset: SHARE_PAGE_SIZE, start: SHARE_PAGE_SIZE + 1,
    end: SHARE_PAGE_SIZE * 2, hasPrevious: true, hasNext: true,
  });
  assert.equal(getSharePagination(21, 99).page, 1);
});
