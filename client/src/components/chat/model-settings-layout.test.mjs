import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('model settings uses one panel in shared desktop and mobile popover shell', async () => {
  const [control, panel, popover, styles] = await Promise.all([read('./ModelSettingsControl.tsx'), read('./ModelSettingsPanel.tsx'), read('../ui/Popover.tsx'), read('../../styles/message-ui.css')]);
  assert.match(control, /<Popover/);
  assert.match(control, /mobile=\{isMobile\}/);
  assert.match(control, /mobilePresentation="sheet"/);
  assert.doesNotMatch(control, /model-settings-sheet/);
  assert.doesNotMatch(control, /createPortal/);
  assert.match(popover, /window\.visualViewport/);
  assert.match(control + panel + styles, /safe-area-inset-bottom/);
  assert.equal((control.match(/<ModelSettingsPanel/g) || []).length, 1);
  assert.doesNotMatch(panel, /type=["']search["']/);
  assert.match(panel, /overflow-y-auto/);
  assert.match(panel, /sticky top-0/);
  assert.match(panel, /sticky bottom-0/);
});

test('composer model trigger is strictly one line and truncates', async () => {
  const source = await read('./ModelSettingsControl.tsx');
  assert.match(source, /whitespace-nowrap/);
  assert.match(source, /truncate/);
  assert.match(source, /min-w-0/);
  assert.match(source, /viewBox="0 0 12 12"/);
  assert.match(source, /M3 4\.5l3 3 3-3/);
  assert.doesNotMatch(source, />⌄</);
});

test('model selector and reasoning slider expose concrete defaults', async () => {
  const [panel, styles] = await Promise.all([read('./ModelSettingsPanel.tsx'), read('../../styles/message-ui.css')]);
  assert.match(panel, /⚡ 快速/);
  assert.match(panel, /aria-label="模型选择"/);
  assert.match(panel, /type="range"/);
  assert.match(panel, /model-settings-reasoning-dots/);
  assert.match(panel, /model-settings-reasoning-fill/);
  assert.match(panel, /index <= selectedReasoningIndex/);
  assert.match(panel, /13 - ratio \* 26/);
  assert.match(panel, /getReasoningTone/);
  assert.match(panel, />模型设置</);
  assert.match(styles, /height:18px/);
  assert.match(styles, /width:26px/);
  assert.match(styles, /model-settings-reasoning-heading \{[^}]*min-height:1\.5rem/);
  assert.match(styles, /model-settings-reasoning-marks span \{[^}]*white-space:nowrap/);
  assert.match(styles, /model-settings-reasoning-marks \{[^}]*font-size:clamp\(8px,2\.4vw,10px\)/);
  assert.match(styles, /model-settings-reasoning input:disabled \{[^}]*opacity:1/);
  assert.match(styles, /background:var\(--reasoning-accent\)/);
  assert.doesNotMatch(styles, /model-settings-reasoning-track[^}]*linear-gradient/);
  assert.match(panel, /aria-valuetext/);
  assert.match(panel, /isAutomaticModel \? <div className="model-settings-reasoning-auto">/);
  assert.match(panel, /自动选择具体模型时，将使用该模型的默认推理强度。/);
  assert.match(panel, /\? <span>跟随模型默认<\/span>/);
  assert.match(styles, /\.model-settings-reasoning-auto \{/);
  assert.match(panel, /knownDefaultReasoningIndex >= 0/);
  assert.match(panel, /\{ id: null, label: '模型默认' \}/);
  assert.match(panel, /模型默认/);
  assert.doesNotMatch(panel, /selectedModel\.description/);
  assert.doesNotMatch(panel, /恢复模型默认/);
});

test('running task only disables applying model settings', async () => {
  const [control, panel, chatInput] = await Promise.all([
    read('./ModelSettingsControl.tsx'),
    read('./ModelSettingsPanel.tsx'),
    read('./ChatInput.tsx'),
  ]);
  const reasoningInput = panel.match(/<input[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(chatInput, /applyDisabled=\{isStreaming \|\| isQueued \|\| isAwaitingAction \|\| isSubmitting\}/);
  assert.match(chatInput, /onOpen=\{\(\) => \{ void loadModels\(selectedEngine, \{ refresh: true \}\)/);
  assert.match(control, /applyDisabled=\{applyDisabled\}/);
  assert.doesNotMatch(panel, /<select[^>]*disabled=/);
  assert.match(reasoningInput, /type="range"/);
  assert.doesNotMatch(reasoningInput, /disabled=/);
  assert.match(panel, /onClick=\{onApply\} disabled=\{applyDisabled \|\| submitting\}/);
});
