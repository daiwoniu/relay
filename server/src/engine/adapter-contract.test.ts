import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter } from '../codex/adapter.js';
import { CodeBuddyAdapter } from '../codebuddy/adapter.js';
import { OpenCodeAdapter } from '../opencode/adapter.js';
import { ZcodeAdapter } from '../zcode/adapter.js';
import type { EngineInteractionAdapter, EngineModelAdapter, EngineRecoveryAdapter, EngineTerminalAdapter } from './facets.js';
import { defineNormalizedInteraction } from './interactions.js';

test('Codex、CodeBuddy 与 OpenCode Adapter 暴露统一的必选能力分面', () => {
  const adapters = [
    new CodexAdapter(),
    new CodeBuddyAdapter(),
    new OpenCodeAdapter(),
    new ZcodeAdapter(),
  ];

  for (const adapter of adapters) {
    const candidate = adapter as any;
    assert.equal(candidate.descriptor.id, candidate.id);
    assert.equal(typeof candidate.runtime.connect, 'function');
    assert.equal(typeof candidate.availability.getCurrent, 'function');
    assert.equal(typeof candidate.diagnostics.classify, 'function');
    assert.equal(typeof candidate.health.inspectLocal, 'function');
    assert.equal(typeof candidate.concurrency.resolveResource, 'function');
  }
});

test('缺失的可选分面不会被伪造为空实现', () => {
  const adapter = new CodeBuddyAdapter() as any;
  for (const facet of [
    'protocol',
    'sessions',
    'terminal',
    'process',
    'commands',
    'maintenance',
  ]) {
    assert.equal(adapter[facet], undefined);
  }
});

test('引擎显式声明重启恢复策略，terminal 分面仍保持可选', () => {
  const recovery: EngineRecoveryAdapter = { restartMode: 'resume' };
  const terminal: EngineTerminalAdapter = { toTurnFact: () => null };
  assert.equal(recovery.restartMode, 'resume');
  assert.equal(terminal.toTurnFact({} as never, {} as never), null);
  assert.equal(new CodexAdapter().recovery.restartMode, 'resume');
  assert.equal(new CodeBuddyAdapter().recovery.restartMode, 'interrupt');
  assert.equal(new OpenCodeAdapter().recovery.restartMode, 'interrupt');
  // zcode 恢复快照协议未实现，声明 interrupt 避免重启后会话永久停留在"恢复中"。
  assert.equal(new ZcodeAdapter().recovery.restartMode, 'interrupt');
  assert.equal((new CodexAdapter() as any).terminal, undefined);
});

test('models 分面提供动态目录且保持可选', async () => {
  const models: EngineModelAdapter = { listModels: async () => ({ engineId: 'codex', fetchedAt: 1, stale: false, models: [] }) };
  assert.equal((await models.listModels()).engineId, 'codex');
  assert.equal(typeof (new CodexAdapter() as any).models.listModels, 'function');
  assert.equal(typeof (new CodeBuddyAdapter() as any).models.listModels, 'function');
  assert.equal(typeof (new OpenCodeAdapter() as any).models.listModels, 'function');
  assert.equal(typeof (new ZcodeAdapter() as any).models.listModels, 'function');
});

test('interactions 分面使用标准请求和标准动作且保持可选', () => {
  const interactions: EngineInteractionAdapter = {
    normalize: (request) => defineNormalizedInteraction({
      requestId: request.requestId,
      kind: 'unknown',
      snapshot: { title: '未知请求' },
      availableActions: [],
    }),
    buildResponse: (_request, command) => ({ action: command.action }),
  };
  assert.equal(interactions.normalize({ requestId: 1, method: 'unknown', params: {} }).autoApprovable, false);
  assert.deepEqual(
    interactions.buildResponse({ requestId: 1, method: 'unknown', params: {} }, { action: 'cancel' }),
    { action: 'cancel' },
  );
  assert.equal(typeof (new CodexAdapter() as any).interactions.normalize, 'function');
  assert.equal(typeof (new CodeBuddyAdapter() as any).interactions.buildResponse, 'function');
  assert.equal(typeof (new OpenCodeAdapter() as any).interactions.normalize, 'function');
});
