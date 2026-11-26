import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCompactTokens } from '../../../../server/src/integrations/feishu-im/reply-display.ts';

test('formats token counts with at most two decimals and preserves zero', () => {
  assert.deepEqual([0, 856, 1_000, 3_482, 28_640, 999_994, 999_995, 1_240_000].map(formatCompactTokens),
    ['0', '856', '1K', '3.48K', '28.64K', '999.99K', '1M', '1.24M']);
});
