import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./ProcessSteps.tsx', import.meta.url), 'utf8');

test('进行中过程回复观察真实内容高度并使用单一滚动帧', () => {
  assert.match(source, /ref=\{narrativeScrollRef\}/);
  assert.match(source, /ref=\{narrativeContentRef\}/);
  assert.match(source, /observer\.observe\(content\)/);
  assert.match(source, /narrativeScrollFrameRef\.current !== null/);
  assert.match(source, /narrativeScrollFrameRef\.current = requestAnimationFrame/);
});

test('过程回复只在进行中和展开时自动跟随', () => {
  assert.match(source, /status !== 'in_progress' \|\| !effectiveExpanded/);
  assert.match(source, /getNextFollowLatestState\(\{/);
  assert.match(source, /onScroll=\{handleNarrativeScroll\}/);
});

test('过程回复滚动帧清理同时取消任务并释放标记', () => {
  assert.match(
    source,
    /cancelAnimationFrame\(narrativeScrollFrameRef\.current\);\s*narrativeScrollFrameRef\.current = null;/,
  );
});
