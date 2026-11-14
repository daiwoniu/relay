import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('filesystem-core.ts', import.meta.url), 'utf8');

test('filesystem Router 将预览与主机浏览工具委托给独立模块', () => {
  assert.match(source, /from '\.\/filesystem-preview\.js'/);
  assert.match(source, /from '\.\/filesystem-host-browser\.js'/);
  assert.doesNotMatch(source, /function decodeTextPreview\(/);
  assert.doesNotMatch(source, /function listHostFileEntries\(/);
});

test('filesystem Router 保留 realpath 与能力令牌授权边界', () => {
  assert.match(source, /function isFileAllowed\(/);
  assert.match(source, /fileAccessGrants\.allows\(realPath, accessToken, actor\.userId\)/);
  assert.match(source, /function resolveAllowedFile\(/);
  assert.match(source, /fileAccessGrants\.grant\(/);
});

test('filesystem Router 主文件保持在 600 行以内', () => {
  assert.ok(source.split(/\r?\n/).length <= 600);
});
