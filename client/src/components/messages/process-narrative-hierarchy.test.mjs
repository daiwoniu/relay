import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./ProcessSteps.tsx', import.meta.url), 'utf8');

test('过程回复使用独立一级区块并按运行状态切换语义背景', () => {
  assert.match(source, /data-process-narrative/);
  assert.match(source, /process-narrative process-narrative--\$\{status\}/);
  assert.match(source, /rounded-lg border/);
  assert.doesNotMatch(source, /process-narrative[^\n]*shadow-sm/);
  assert.match(source, /status === 'in_progress'[\s\S]*color-notice-info-border[\s\S]*color-notice-info-bg/);
  assert.match(source, /status === 'stopped'[\s\S]*color-notice-attention-border[\s\S]*color-notice-attention-bg/);
});

test('过程回复正文与标题属于同一卡片且执行区段不再增加视觉卡片', () => {
  assert.match(source, /data-process-narrative-content/);
  assert.match(source, /border-t border-\[var\(--color-border-light\)\]/);
  assert.match(source, /data-process-execution-group/);
  assert.doesNotMatch(source, /data-process-execution-group[^>]*className=/);
});
