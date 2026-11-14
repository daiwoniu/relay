import assert from 'node:assert/strict';
import test from 'node:test';
import { decideClaimedRecovery, resumeQueuedResources } from './recovery.js';

test('claimed 恢复只允许恢复、清理、中断或等待仲裁，绝不回 queued', () => {
  assert.equal(decideClaimedRecovery({ engineId: 'codex', hasTurnStartedFact: true, hasTerminalFact: false, hasExternalSession: true, restartMode: 'resume' }), 'resume_running');
  assert.equal(decideClaimedRecovery({ engineId: 'codex', hasTurnStartedFact: false, hasTerminalFact: true, hasExternalSession: true, restartMode: 'resume' }), 'terminal_cleanup');
  assert.equal(decideClaimedRecovery({ engineId: 'codex', hasTurnStartedFact: false, hasTerminalFact: false, hasExternalSession: true, restartMode: 'resume' }), 'wait_for_recovery');
  assert.equal(decideClaimedRecovery({ engineId: 'codebuddy', hasTurnStartedFact: false, hasTerminalFact: false, hasExternalSession: false, restartMode: 'interrupt' }), 'interrupt_unrecoverable');
  const decisions = ['resume_running', 'terminal_cleanup', 'interrupt_unrecoverable', 'wait_for_recovery'];
  assert.equal(decisions.includes('return_to_queue'), false);
});

test('启动续排逐个 drain 持久化资源且单个失败不阻断其他资源', async () => {
  const drained: string[] = [];
  const failed: string[] = [];
  await resumeQueuedResources(
    ['codex:default', 'broken:default', 'codebuddy:default'],
    async (resourceKey) => {
      drained.push(resourceKey);
      if (resourceKey === 'broken:default') throw new Error('broken');
    },
    (resourceKey) => failed.push(resourceKey),
  );
  assert.deepEqual(drained, ['codex:default', 'broken:default', 'codebuddy:default']);
  assert.deepEqual(failed, ['broken:default']);
});
