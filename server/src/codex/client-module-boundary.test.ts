import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('client.ts', import.meta.url), 'utf8');

test('Codex client façade 委托 thread、agent message、turn facts 与 turn retry 模块', () => {
  assert.ok(/from '\.\/client-thread\.js'/.test(source));
  assert.ok(/from '\.\/client-agent-messages\.js'/.test(source));
  assert.ok(/from '\.\/client-turn-facts\.js'/.test(source));
  assert.ok(/from '\.\/client-turn-retry\.js'/.test(source));
  assert.ok(!/function buildThreadOpenRequest\(/.test(source));
  assert.ok(!/function rebuildAgentMessageBuffers\(/.test(source));
  assert.ok(!/function extractTurnFailure\(/.test(source));
  assert.ok(!/function getTurnStartRetryDelay\(/.test(source));
});

test('Codex client façade 保留连接、重试、server request 与通知顺序所有权', () => {
  assert.match(source, /export function createCodexConnection\(/);
  assert.match(source, /async function sendTurnStartWithRetry\(/);
  assert.match(source, /function handleServerRequest\(/);
  assert.match(source, /function handleNotification\(/);
});

test('上下文整理通知保留 Codex thread 与 turn 幂等身份', () => {
  assert.match(source, /type: 'item_complete',[\s\S]*threadId: params\.threadId,[\s\S]*turnId: params\.turnId/);
  assert.match(source, /case 'thread\/compacted':[\s\S]*contextCompaction: \{ threadId: params\.threadId, turnId: params\.turnId \}/);
});

test('Codex client 主文件保持在 1270 行以内', () => {
  assert.ok(source.split(/\r?\n/).length <= 1_270);
});
