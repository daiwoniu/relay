import assert from 'node:assert/strict';
import test from 'node:test';
import { getShareCaution } from './share-caution.ts';

test('分享风险提示根据处理过程与有效期组合变化', () => {
  assert.equal(getShareCaution(false, '1d'), null);
  assert.match(getShareCaution(true, '1d')?.title || '', /敏感信息/);
  assert.match(getShareCaution(false, 'permanent')?.title || '', /不会自动失效/);
  assert.match(getShareCaution(true, 'permanent')?.title || '', /高敏感度/);
});
