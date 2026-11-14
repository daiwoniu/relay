import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyEngineMaintenanceFixtures } from './verify-engine-maintenance.js';

test('隔离 fixture 验证两个引擎分别按活动任务和实例阻断', async () => {
  assert.deepEqual(await verifyEngineMaintenanceFixtures(), {
    codexRestartAllowed: true,
    codexUpgradeBlocked: true,
    codeBuddyUpgradeBlocked: true,
    independentCounts: true,
    codexUpgradeTransaction: true,
    codeBuddyRollbackTransaction: true,
    sharedDestructiveMutex: true,
    strictProtocols: true,
    transactionCleanup: true,
  });
});
