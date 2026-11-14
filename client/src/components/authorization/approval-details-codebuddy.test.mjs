import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./ApprovalDetails.tsx', import.meta.url), 'utf8');

test('CodeBuddy 授权详情展示工具名称与文件目标但不展开原始输入', () => {
  assert.match(source, /工具：/);
  assert.match(source, /目标文件：/);
  assert.doesNotMatch(source, /JSON\.stringify\(details\.rawInput/);
});
