import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAcceptanceArguments, runEngineScenarios } from './lib/engine-scenarios.mjs';

test('真实引擎必须同时显式提供 allow、engine 和 scenario', () => {
  assert.deepEqual(parseAcceptanceArguments([]), { mode: 'read-only' });
  assert.deepEqual(parseAcceptanceArguments(['--workbench']), { mode: 'read-only', workbench:true });
  assert.deepEqual(parseAcceptanceArguments(['--feishu-approvals']), { mode: 'read-only', feishuApprovals: true });
  assert.deepEqual(parseAcceptanceArguments(['--feishu-approvals-built']), { mode: 'read-only', feishuApprovals: true, built: true });
  assert.throws(()=>parseAcceptanceArguments(['--workbench','--allow-engine-run','--engine','codex','--scenario','complete']),/未知参数/u);
  for (const args of [
    ['--allow-engine-run'],
    ['--engine', 'codex', '--scenario', 'complete'],
    ['--allow-engine-run', '--engine', 'codex'],
    ['--allow-engine-run', '--scenario', 'complete'],
  ]) assert.throws(() => parseAcceptanceArguments(args), /必须同时明确/u);
  assert.deepEqual(parseAcceptanceArguments(['--allow-engine-run', '--engine', 'codex', '--scenario', 'complete']), { mode: 'engine', engine: 'codex', scenario: 'complete' });
  assert.deepEqual(parseAcceptanceArguments(['--allow-engine-run', '--engine', 'all', '--scenario', 'refresh']), { mode: 'engine', engine: 'all', scenario: 'refresh' });
  assert.throws(() => parseAcceptanceArguments(['--allow-engine-run', '--engine', 'other', '--scenario', 'complete']), /engine/u);
  assert.throws(() => parseAcceptanceArguments(['--allow-engine-run', '--engine', 'codex', '--scenario', 'unknown']), /scenario/u);
  assert.throws(() => parseAcceptanceArguments(['--mystery']), /未知参数/u);
});

function fakePage({ terminal = { userCount: 1, assistantCount: 1, terminalCount: 1, outcome: 'completed' } } = {}) {
  const calls = [];
  return {
    calls,
    async createAcceptanceSession(value) { calls.push(['create', value]); return { id: `session-${value.engine}` }; },
    async openSession(value) { calls.push(['open', value]); },
    async assertEngineSelected(value) { calls.push(['engine', value]); },
    async sendPrompt(value) { calls.push(['send', value]); },
    async waitForProcessing() { calls.push(['processing']); },
    async stopGeneration() { calls.push(['stop']); },
    async reload() { calls.push(['reload']); },
    async waitForStable() { calls.push(['stable']); },
    async waitForTerminal() { calls.push(['terminal']); return terminal; },
  };
}

test('complete 为每个明确引擎只创建一次前缀会话并等待唯一终态', async () => {
  const page = fakePage();
  const results = await runEngineScenarios({ page, engine: 'all', scenario: 'complete', now: () => 123 });
  assert.deepEqual(results.map((item) => item.engine), ['codex', 'codebuddy']);
  assert.ok(page.calls.filter(([name]) => name === 'create').every(([, value]) => value.title.startsWith('[HEADLESS-ACCEPTANCE]')));
  assert.equal(page.calls.filter(([name]) => name === 'send').length, 2);
  assert.equal(results.every((item) => item.status === 'passed'), true);
  assert.equal(JSON.stringify(results).includes('请只回复'), false);
});

test('stop 只在 processing 后停止并等待 stopped 终态', async () => {
  const page = fakePage({ terminal: { userCount: 1, assistantCount: 1, terminalCount: 1, outcome: 'stopped' } });
  const [result] = await runEngineScenarios({ page, engine: 'codex', scenario: 'stop' });
  assert.ok(page.calls.findIndex(([name]) => name === 'processing') < page.calls.findIndex(([name]) => name === 'stop'));
  assert.equal(result.status, 'passed');
});

test('refresh 在 processing 期间刷新且不接受重复消息终态', async () => {
  const page = fakePage({ terminal: { userCount: 1, assistantCount: 2, terminalCount: 2, outcome: 'completed' } });
  const [result] = await runEngineScenarios({ page, engine: 'codebuddy', scenario: 'refresh' });
  assert.ok(page.calls.findIndex(([name]) => name === 'processing') < page.calls.findIndex(([name]) => name === 'reload'));
  assert.equal(result.status, 'failed');
});

test('Provider 不可用、正式重启要求和进程崩溃返回 inconclusive', async () => {
  for (const code of ['provider_unavailable', 'restart_required', 'process_crash']) {
    const page = fakePage();
    page.waitForTerminal = async () => { throw Object.assign(new Error('not available'), { code }); };
    const [result] = await runEngineScenarios({ page, engine: 'codex', scenario: 'complete' });
    assert.equal(result.status, 'inconclusive');
  }
  const page = fakePage({ terminal: { userCount: 1, assistantCount: 1, terminalCount: 1, outcome: 'failed', errorCode: 'CODEBUDDY_PROVIDER_ERROR' } });
  const [result] = await runEngineScenarios({ page, engine: 'codebuddy', scenario: 'complete' });
  assert.equal(result.status, 'inconclusive');
});
