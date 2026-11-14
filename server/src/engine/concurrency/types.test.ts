import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeBuddyAdapter } from '../../codebuddy/adapter.js';
import { CodexAdapter } from '../../codex/adapter.js';
import { validateEngineConcurrencyResource } from './types.js';

const context = { sessionId: 'session-1', projectId: 'project-1' };

test('Codex 与 CodeBuddy 暴露独立的默认并发资源', () => {
  assert.deepEqual(new CodexAdapter().concurrency?.resolveResource(context), {
    resourceKey: 'codex:default',
    providerKey: null,
    label: 'Codex',
    defaultMaxActiveTurns: 2,
  });
  assert.deepEqual(new CodeBuddyAdapter().concurrency?.resolveResource(context), {
    resourceKey: 'codebuddy:default',
    providerKey: null,
    label: 'CodeBuddy',
    defaultMaxActiveTurns: 4,
  });
});

test('并发资源验证接受稳定脱敏键和边界上限', () => {
  assert.deepEqual(validateEngineConcurrencyResource({
    resourceKey: 'codex:provider_1.test',
    providerKey: 'provider_1',
    label: 'Codex Provider',
    defaultMaxActiveTurns: 1,
  }), {
    resourceKey: 'codex:provider_1.test',
    providerKey: 'provider_1',
    label: 'Codex Provider',
    defaultMaxActiveTurns: 1,
  });
  assert.equal(validateEngineConcurrencyResource({
    resourceKey: 'codebuddy:default',
    providerKey: null,
    label: 'CodeBuddy',
    defaultMaxActiveTurns: 32,
  }).defaultMaxActiveTurns, 32);
});

test('并发资源验证拒绝 URL、路径、空标签和越界上限', () => {
  for (const input of [
    { resourceKey: 'https://provider.example', providerKey: null, label: 'Provider', defaultMaxActiveTurns: 2 },
    { resourceKey: 'codex:C:\\secret', providerKey: null, label: 'Provider', defaultMaxActiveTurns: 2 },
    { resourceKey: 'codex:default', providerKey: null, label: '', defaultMaxActiveTurns: 2 },
    { resourceKey: 'codex:default', providerKey: null, label: 'Codex', defaultMaxActiveTurns: 0 },
    { resourceKey: 'codex:default', providerKey: null, label: 'Codex', defaultMaxActiveTurns: 33 },
  ]) {
    assert.throws(() => validateEngineConcurrencyResource(input));
  }
});
