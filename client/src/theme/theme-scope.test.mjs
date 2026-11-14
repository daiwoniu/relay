import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveThemeScope } from './theme-scope.ts';

test('公开分享优先隔离账号主题', () => {
  assert.equal(resolveThemeScope('/share/token', 'authenticated'), 'public-share');
  assert.equal(resolveThemeScope('/share', 'guest'), 'public-share');
});

test('普通页面按认证状态选择工作区或访客主题', () => {
  assert.equal(resolveThemeScope('/', 'authenticated'), 'workspace');
  assert.equal(resolveThemeScope('/', 'loading'), 'workspace');
  assert.equal(resolveThemeScope('/', 'guest'), 'guest');
  assert.equal(resolveThemeScope('/', 'error'), 'workspace');
});

test('工具集始终使用公开页主题，不在确认登录时闪入账号主题', () => {
  for (const status of ['loading', 'error', 'authenticated', 'guest']) {
    assert.equal(resolveThemeScope('/tools', status), 'public-tools');
  }
});
