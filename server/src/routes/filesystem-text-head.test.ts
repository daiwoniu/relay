import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import rawRouter from './filesystem.js';
import { MAX_TEXT_HEAD_BYTES, MAX_TEXT_PREVIEW_SIZE, readTextPreviewHead } from './filesystem-preview.js';

test('超大文本接口只返回前100行，保留原文件大小与截断标记', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-text-head-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'large.log');
  fs.writeFileSync(filePath, Array.from({ length: 105 }, (_, i) => `第${i + 1}行`).join('\r\n') + '\r\n' + 'tail'.repeat(MAX_TEXT_PREVIEW_SIZE / 4));
  const router = new Hono<RelayEnv>();
  router.use('*', async (c, next) => {
    c.set('relayActor', { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin' });
    await next();
  });
  router.route('/', rawRouter);
  const authorize = await router.request('http://localhost/authorize-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
  });
  assert.equal(authorize.status, 200);
  const { accessToken } = await authorize.json() as { accessToken: string };
  const response = await router.request(`http://localhost/read?path=${encodeURIComponent(filePath)}&accessToken=${accessToken}`);
  assert.equal(response.status, 200);
  const body = await response.json() as { type: string; content: string; size: number; truncated: boolean };
  assert.equal(body.type, 'text');
  assert.equal(body.truncated, true);
  assert.equal(body.size, fs.statSync(filePath).size);
  assert.ok(body.size > MAX_TEXT_PREVIEW_SIZE);
  assert.equal(body.content.split('\r\n').length, 100);
  assert.ok(body.content.endsWith('第100行'));
  assert.doesNotMatch(body.content, /第101行|tail/);
  assert.ok(Buffer.byteLength(body.content) <= MAX_TEXT_HEAD_BYTES);
  const denied = await router.request(`http://localhost/read?path=${encodeURIComponent(filePath)}`);
  assert.equal(denied.status, 403);
});

test('超长单行受64KB上限约束，UTF-8截断不产生乱码且文件句柄关闭', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-text-head-utf8-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'long.txt');
  // 65536 cuts a three-byte character after its first byte.
  fs.writeFileSync(filePath, '中'.repeat(30_000));
  const content = await readTextPreviewHead(filePath);
  assert.equal(content, '中'.repeat(Math.floor(MAX_TEXT_HEAD_BYTES / 3)));
  assert.ok(Buffer.byteLength(content!) <= MAX_TEXT_HEAD_BYTES);
  assert.doesNotMatch(content!, /\uFFFD/);
  fs.renameSync(filePath, path.join(root, 'renamed.txt'));
});

test('截断读取仍拒绝二进制和非法UTF-8，兼容CR及LF换行', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-text-head-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'sample.txt');
  for (const buffer of [Buffer.from([0x61, 0, 0x62]), Buffer.from([0xc3, 0x28]), Buffer.from([1, 2])]) {
    fs.writeFileSync(filePath, buffer);
    assert.equal(await readTextPreviewHead(filePath), null);
  }
  for (const newline of ['\r', '\n']) {
    fs.writeFileSync(filePath, Array.from({ length: 105 }, (_, i) => String(i + 1)).join(newline));
    assert.equal((await readTextPreviewHead(filePath))?.split(newline).length, 100);
  }
});
