import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const interactionPanel = fs.readFileSync(new URL('InteractionPanel.tsx', import.meta.url), 'utf8');
const processSteps = fs.readFileSync(new URL('ProcessSteps.tsx', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../../styles/message-ui.css', import.meta.url), 'utf8');

test('已处理授权标题与普通操作组使用相同紧凑尺寸', () => {
  assert.match(interactionPanel, /interaction-card__header[\s\S]*?items-center gap-1\.5 px-2\.5 py-1\.5 text-left text-xs/);
  assert.match(processSteps, /process-group__main[\s\S]*?items-center gap-1\.5 text-left text-xs/);
  assert.match(styles, /\.process-narrative__main,[\s\S]*?\.process-group__main\s*\{[\s\S]*?padding:\s*\.25rem \.5rem/);
  assert.match(interactionPanel, /pending\s*\? 'my-1 rounded-xl p-3'\s*: 'my-0\.5 last:mb-1\.5 overflow-hidden rounded-lg'/);
});

test('待处理授权继续使用原有醒目标题尺寸', () => {
  assert.match(interactionPanel, /flex items-center gap-2 text-sm font-medium/);
  assert.match(interactionPanel, /pending\s*\? 'flex w-full cursor-default items-start justify-between gap-3 text-left'/);
  assert.match(interactionPanel, /approvalPresentation\.typeLabel/);
  assert.match(interactionPanel, /approvalPresentation\.purpose/);
});

test('待处理授权标题在移动端单行省略并在桌面端恢复换行', () => {
  assert.match(
    interactionPanel,
    /min-w-0 truncate sm:overflow-visible sm:whitespace-normal sm:text-clip sm:break-words/,
  );
});

test('已处理授权来源信息移入展开内容避免增加标题高度', () => {
  assert.match(interactionPanel, /!pending && details\.serverName/);
  assert.match(interactionPanel, /border-t border-\[var\(--color-border-light\)\] px-2\.5 py-2/);
});

test('授权按钮优先保持一行并仅在宽度不足时自然换行', () => {
  assert.match(interactionPanel, /flex flex-wrap justify-end gap-2/);
  assert.match(interactionPanel, /\[&>button\]:shrink-0/);
  assert.match(interactionPanel, /\[&>button\]:whitespace-nowrap/);
});
