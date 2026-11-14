import assert from 'node:assert/strict';
import test from 'node:test';
import { registerMinimizedPanel, restoreMinimizedPanel } from './minimizedPanelRegistry.ts';

test('重复打开只恢复匹配的最小化窗口，关闭后不再触发旧操作', () => {
  let shares = 0;
  let trash = 0;
  const unregisterShares = registerMinimizedPanel('shares', () => { shares += 1; });
  const unregisterTrash = registerMinimizedPanel('trash', () => { trash += 1; });

  assert.equal(restoreMinimizedPanel('shares'), true);
  assert.equal(shares, 1);
  assert.equal(trash, 0);
  assert.equal(restoreMinimizedPanel('missing'), false);

  unregisterShares();
  assert.equal(restoreMinimizedPanel('shares'), false);
  unregisterTrash();
});
