import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('桌面下一轮模型入口支持点击打开设置弹层', () => {
  const source = fs.readFileSync(new URL('ModelSettingsControl.tsx', import.meta.url), 'utf8');
  assert.match(source, /onClick=\{show\}[\s\S]*?<Popover[\s\S]*?label="模型设置"/);
});
