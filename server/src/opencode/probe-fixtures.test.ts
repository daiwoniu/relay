import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

const forbiddenPatterns = [
  /(?:[A-Za-z]:\\|\\\\)[^\s"']+/,
  /\/(?:Users|home|root|private|var\/folders)\//i,
  /\b(?:authorization|cookie|sessionToken|connectionId)\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|provider[_-]?key)\b/i,
];

test('OpenCode 协议 fixture 是合法且脱敏的 JSONL', async () => {
  const fixturePath = path.join(fixtureDirectory, 'acp-basic.jsonl');
  const content = await readFile(fixturePath, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim());

  assert.ok(lines.length > 0, 'acp-basic.jsonl 不得为空');
  for (const [index, line] of lines.entries()) {
    const envelope = JSON.parse(line) as Record<string, unknown>;
    assert.equal(typeof envelope, 'object', `acp-basic.jsonl:${index + 1} 必须是对象`);
    assert.ok(
      'method' in envelope || 'result' in envelope || 'error' in envelope,
      `acp-basic.jsonl:${index + 1} 必须是 JSON-RPC 事件`,
    );
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(line, pattern, `acp-basic.jsonl:${index + 1} 包含敏感信息`);
    }
  }
});

async function loadFixture(name: string): Promise<Record<string, any>[]> {
  const content = await readFile(path.join(fixtureDirectory, name), 'utf8');
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, any>);
}

test('OpenCode 协议 fixture 覆盖并发基本探针', async () => {
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
});

test('OpenCode 协议 fixture 使用 ACP 规范 session/update 通知且正文结构正确', async () => {
  const basic = await loadFixture('acp-basic.jsonl');
  const updates = basic.filter((event) => event.method === 'session/update');
  assert.equal(updates.length, 4, '应包含消息与 usage 更新通知');
  assert.equal(basic.filter((event) => event.method === 'notifications/update').length, 0);

  const payload = (event: Record<string, any>) => event.params?.update as Record<string, any> | undefined;
  const messageChunks = updates.filter((event) => payload(event)?.sessionUpdate === 'agent_message_chunk');
  assert.equal(messageChunks.length, 2, '两个探针各应有一次消息正文块');
  for (const chunk of messageChunks) {
    assert.equal(payload(chunk)?.content?.type, 'text');
    assert.equal(typeof payload(chunk)?.content?.text, 'string');
    assert.equal(typeof payload(chunk)?.messageId, 'string');
  }

  const usageUpdates = updates.filter((event) => payload(event)?.sessionUpdate === 'usage_update');
  assert.equal(usageUpdates.length, 2);
  for (const usage of usageUpdates) {
    assert.ok(Number(payload(usage)?.used) > 0);
  }

  const sessionResults = basic.filter((event) => event._direction === 'server' && event.result?.configOptions);
  assert.equal(sessionResults.length, 2, 'session/new result 应携带 model configOption');
  for (const event of sessionResults) {
    const model = (event.result?.configOptions ?? []).find((option: any) => option.category === 'model' || option.id === 'model');
    assert.equal(model?.id, 'model');
    assert.equal(typeof model?.currentValue, 'string');
  }
});

test('probe 脚本使用 opencode acp 子命令且协议版本为数字 1', async () => {
  const source = await readFile(new URL('../../scripts/probe-opencode-acp.ts', import.meta.url), 'utf8');
  assert.match(source, /'acp',\s*\.\.\.extraArgs/);
  assert.match(source, /protocolVersion:\s*1\b/);
  assert.match(source, /opencode-ai/);
  assert.match(source, /name:\s*'relay-opencode-probe'/);
  assert.match(source, /options\.mode === 'availability'/);
  assert.doesNotMatch(source, /--acp-transport/);
  assert.doesNotMatch(source, /--agent\b/);
  assert.doesNotMatch(source, /--mode activity:/);
  assert.doesNotMatch(source, /codebuddy/i);
  assert.doesNotMatch(source, /codex-edge/i);
});
