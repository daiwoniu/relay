import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

const fixtureNames = [
  'acp-basic.jsonl',
  'acp-replay.jsonl',
  'acp-interactions.jsonl',
  'acp-failure.jsonl',
] as const;

const forbiddenPatterns = [
  /(?:[A-Za-z]:\\|\\\\)[^\s"']+/,
  /\/(?:Users|home|root|private|var\/folders)\//i,
  /\b(?:authorization|cookie|sessionToken|connectionId)\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|provider[_-]?key)\b/i,
];

test('CodeBuddy 协议 fixture 是合法且脱敏的 JSONL', async () => {
  for (const fixtureName of fixtureNames) {
    const fixturePath = path.join(fixtureDirectory, fixtureName);
    const content = await readFile(fixturePath, 'utf8');
    const lines = content.split(/\r?\n/).filter((line) => line.trim());

    assert.ok(lines.length > 0, `${fixtureName} 不得为空`);
    for (const [index, line] of lines.entries()) {
      const envelope = JSON.parse(line) as Record<string, unknown>;
      assert.equal(typeof envelope, 'object', `${fixtureName}:${index + 1} 必须是对象`);
      assert.ok(
        'method' in envelope || 'result' in envelope || 'error' in envelope,
        `${fixtureName}:${index + 1} 必须是 JSON-RPC 事件`,
      );
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(line, pattern, `${fixtureName}:${index + 1} 包含敏感信息`);
      }
    }
  }
});

async function loadFixture(name: typeof fixtureNames[number]): Promise<Record<string, any>[]> {
  const content = await readFile(path.join(fixtureDirectory, name), 'utf8');
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, any>);
}

test('CodeBuddy 协议 fixture 覆盖并发、恢复、交互、取消与失败', async () => {
  const basic = await loadFixture('acp-basic.jsonl');
  assert.deepEqual(
    new Set(basic.map((event) => event._probe).filter(Boolean)),
    new Set(['1', '2']),
  );
  assert.equal(
    basic.filter((event) => event.method === 'session/prompt' && event._direction === 'client').length,
    2,
  );
  assert.match(JSON.stringify(basic), /ACP_1/);
  assert.match(JSON.stringify(basic), /ACP_2/);

  const replay = await loadFixture('acp-replay.jsonl');
  assert.ok(replay.some((event) => event.method === 'session/load'));
  assert.ok(replay.some((event) => event._probe === 'replay-source'));
  assert.ok(replay.some((event) => event._probe === 'replay-resume'));
  assert.match(JSON.stringify(replay), /SECOND/);
  assert.match(JSON.stringify(replay), /RELAY_FIRST/);
  assert.doesNotMatch(JSON.stringify(replay), /tool_call|request_permission/);

  const interactions = await loadFixture('acp-interactions.jsonl');
  assert.ok(interactions.some((event) => event.method === 'session/request_permission'));
  assert.ok(interactions.some((event) => event.method === 'session/cancel'));
  assert.ok(interactions.some((event) => event.result?.outcome?.outcome === 'cancelled'));

  const failure = await loadFixture('acp-failure.jsonl');
  assert.ok(failure.some((event) => event.method === 'session/delete'));
  assert.ok(failure.some((event) => event.error));
});

test('readiness 模式组合认证、独立进程并发、恢复和取消探针', async () => {
  const source = await readFile(new URL('../../scripts/probe-codebuddy-acp.ts', import.meta.url), 'utf8');
  assert.match(source, /options\.mode === 'readiness'/);
  assert.match(source, /await runBasicProbe\(options\)/);
  assert.match(source, /await runReplayProbe\(options\)/);
  assert.match(source, /await runInteractionProbe\(options\)/);
  assert.match(source, /permissionRequested/);
  assert.match(source, /'--agent',\s*'cli'/);
  assert.match(source, /'--permission-mode',\s*'default'/);
  assert.match(source, /CODEBUDDY_GATEWAY_AUTH: 'password'/);
  assert.match(source, /CODEBUDDY_GATEWAY_PASSWORD: gatewayPassword/);
  assert.match(source, /Authorization: `Bearer \$\{gatewayPassword\}`/);
  assert.match(source, /\/api\/v1\/health/);
  assert.doesNotMatch(source, /port \+ '\/health'/);
  assert.doesNotMatch(source, /CODEBUDDY_GATEWAY_AUTH:\s*'none'/);
});

test('availability 模式只使用单进程验证 ACP 基本可用性', async () => {
  const source = await readFile(new URL('../../scripts/probe-codebuddy-acp.ts', import.meta.url), 'utf8');
  assert.match(source, /options\.mode === 'availability'/);
  assert.match(source, /async function runAvailabilityProbe/);
  assert.match(source, /text: '只回复 OK'/);
});

test('setup 使用轻量 availability 探针而非完整 readiness 验收', async () => {
  const source = await readFile(new URL('../../../scripts/setup.mjs', import.meta.url), 'utf8');
  assert.match(source, /--mode', 'availability'/);
  assert.doesNotMatch(source, /--mode', 'readiness'/);
  assert.match(source, /验证 CodeBuddy 登录与 ACP 基本可用性/);
});
