import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./queries.ts', import.meta.url), 'utf8');

test('queries 通过稳定 façade 暴露低耦合查询模块', () => {
  assert.match(source, /export \* from '\.\/query-types\.js'/);
  assert.match(source, /export \* from '\.\/queries-account\.js'/);
  assert.match(source, /export \* from '\.\/queries-projects\.js'/);
  assert.match(source, /export \* from '\.\/queries-recovery\.js'/);
  assert.match(source, /export \* from '\.\/queries-shares\.js'/);
  assert.doesNotMatch(source, /export function createUserInDatabase\(/);
  assert.doesNotMatch(source, /export function createProject\(/);
  assert.doesNotMatch(source, /export function createSharedRecordInDatabase\(/);
});

test('queries 主文件保持在 1280 行以内', () => {
  assert.ok(source.trimEnd().split(/\r?\n/).length <= 1280);
});
