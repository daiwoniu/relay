import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isPublicSharePath } from './public-share-route.ts';

test('公开分享命名空间匹配并排除相似普通路径', () => {
  assert.equal(isPublicSharePath('/share/abc'), true);
  assert.equal(isPublicSharePath('/share/abc/extra'), true);
  assert.equal(isPublicSharePath('/share'), true);
  assert.equal(isPublicSharePath('/shared/abc'), false);
  assert.equal(isPublicSharePath('/share-settings'), false);
});

test('公开分享页在应用全局锁定滚动时提供独立纵向滚动容器', () => {
  const source = fs.readFileSync(new URL('./PublicSharePage.tsx', import.meta.url), 'utf8');

  assert.match(source, /h-full overflow-y-auto/);
});

test('公开分享失效状态使用断链图标而不是外链箭头', () => {
  const source = fs.readFileSync(new URL('./PublicSharePage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, />↗</);
  assert.match(source, /aria-label=\{getPublicShareStateMessage\(state\.type\)\}/);
  assert.doesNotMatch(source, /aria-label="分享链接已失效"/);
  assert.match(source, /<svg[^>]*viewBox="0 0 24 24"/);
});
