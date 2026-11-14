import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineAdapter, EngineConnectionOptions } from './adapter.js';
import { CodeBuddyAdapter } from '../codebuddy/adapter.js';
import { CodexAdapter } from '../codex/adapter.js';
import { EngineRegistry, EngineRegistryError } from './registry.js';

function createAdapter(
  id: EngineAdapter['id'],
  available: boolean,
  calls: string[],
): EngineAdapter {
  return {
    id,
    descriptor: { id, label: id, capabilities: {
      conversations: true,
      streaming: true,
      processItems: true,
      cancellation: true,
      interactions: true,
      tokenUsage: id === 'codex',
      archive: id === 'codex',
    } },
    availability: { getCurrent: () => ({ available, code: available ? 'AVAILABLE' : 'ENGINE_UNAVAILABLE' }) },
    diagnostics: { classify: () => ({ code: 'TEST', phase: 'connect', retryable: false, userMessage: 'test' }) },
    health: { inspectLocal: async () => ({ engineId: id, observedAt: 0, installation: 'unknown', authentication: 'unknown', protocol: 'unknown', process: 'unknown', readiness: 'unchecked', available, code: 'TEST', message: 'test' }) },
    concurrency: { resolveResource: () => ({ resourceKey: `${id}:default`, providerKey: null, label: id, defaultMaxActiveTurns: id === 'codex' ? 2 : 4 }) },
    runtime: { connect(options: EngineConnectionOptions) {
      calls.push(`${id}:${options.sessionId}`);
      return {
        send: () => undefined,
        cancel: async () => undefined,
        respondToInteraction: () => undefined,
        close: () => undefined,
      };
    } },
  };
}

const options: EngineConnectionOptions = {
  sessionId: 'relay-session',
  cwd: 'D:/workspace',
  externalSessionId: null,
  onSessionReady: () => undefined,
  onEvent: () => undefined,
  onClosed: () => undefined,
};

test('Registry 按数据库中的 session engine 选择 adapter', () => {
  const calls: string[] = [];
  const registry = new EngineRegistry([
    createAdapter('codex', true, calls),
    createAdapter('codebuddy', true, calls),
  ]);

  registry.connect('codebuddy', options);
  assert.deepEqual(calls, ['codebuddy:relay-session']);
});

test('Registry 只通过 availability 与 runtime 分面建立连接', () => {
  const calls: string[] = [];
  const adapter = createAdapter('codex', true, calls) as any;
  assert.equal(typeof adapter.availability.getCurrent, 'function');
  assert.equal(typeof adapter.runtime.connect, 'function');
  assert.equal(adapter.concurrency.resolveResource(options).resourceKey, 'codex:default');
});

test('Registry 中正式 Adapter 暴露引擎专属 interactions 分面', () => {
  const codex = new CodexAdapter();
  const codebuddy = new CodeBuddyAdapter();
  assert.equal(typeof codex.interactions.normalize, 'function');
  assert.equal(typeof codebuddy.interactions.buildResponse, 'function');
});

test('Registry 对未知引擎返回稳定错误', () => {
  const registry = new EngineRegistry([]);
  assert.throws(
    () => registry.connect('unknown' as never, options),
    (error: EngineRegistryError) => error instanceof EngineRegistryError
      && error.code === 'ENGINE_NOT_REGISTERED'
      && error.engine === 'unknown',
  );
});

test('Registry 对不可用引擎返回稳定错误且不建立连接', () => {
  const calls: string[] = [];
  const registry = new EngineRegistry([createAdapter('codebuddy', false, calls)]);
  assert.throws(
    () => registry.connect('codebuddy', options),
    (error: EngineRegistryError) => error instanceof EngineRegistryError
      && error.code === 'ENGINE_UNAVAILABLE'
      && error.engine === 'codebuddy',
  );
  assert.deepEqual(calls, []);
});
