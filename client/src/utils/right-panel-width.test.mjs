import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../styles/style-source.test-helper.mjs';
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  clampRightPanelWidth,
  getRightPanelWidthFromKey,
  readStoredRightPanelWidth,
  storeRightPanelWidth,
} from './right-panel-width.ts';

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set('relay.right-panel.width.v1', initialValue);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('右侧预览宽度限制在允许范围内并支持本地恢复', () => {
  assert.equal(clampRightPanelWidth(100), RIGHT_PANEL_MIN_WIDTH);
  assert.equal(clampRightPanelWidth(560), 560);
  assert.equal(clampRightPanelWidth(1200), RIGHT_PANEL_MAX_WIDTH);
  assert.equal(clampRightPanelWidth(Number.NaN), RIGHT_PANEL_DEFAULT_WIDTH);

  const storage = createStorage();
  storeRightPanelWidth(640, storage);
  assert.equal(readStoredRightPanelWidth(storage), 640);
});

test('右侧边界的键盘方向与边界移动方向一致', () => {
  assert.equal(getRightPanelWidthFromKey(420, 'ArrowLeft'), 430);
  assert.equal(getRightPanelWidthFromKey(420, 'ArrowRight'), 410);
  assert.equal(getRightPanelWidthFromKey(420, 'Home'), RIGHT_PANEL_MIN_WIDTH);
  assert.equal(getRightPanelWidthFromKey(420, 'End'), RIGHT_PANEL_MAX_WIDTH);
  assert.equal(getRightPanelWidthFromKey(420, 'Enter'), null);
});

test('右侧面板拖拽手柄接入统一焦点与宽度语义', () => {
  const panel = [
    fs.readFileSync(new URL('../components/layout/RightPanel.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../components/layout/RightPanelContent.tsx', import.meta.url), 'utf8'),
  ].join('\n');
  const store = fs.readFileSync(new URL('../stores/chat.ts', import.meta.url), 'utf8');

  assert.match(panel, /event\.currentTarget\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /const onResize = \(\) => setIsMobile\(window\.innerWidth < 1024\);\s*onResize\(\);/);
  assert.match(panel, /onKeyDown=\{handleResizeKeyDown\}/);
  assert.match(panel, /aria-valuemin=\{RIGHT_PANEL_MIN_WIDTH\}/);
  assert.match(panel, /aria-valuemax=\{RIGHT_PANEL_MAX_WIDTH\}/);
  assert.match(panel, /className="workspace-preview-resizer__grip"/);
  assert.match(readStyleSource(), /\.workspace-preview-resizer:focus-visible \.workspace-preview-resizer__grip\s*\{[^}]*background: var\(--color-focus-ring\)/s);
  assert.match(store, /rightPanelWidth: readStoredRightPanelWidth\(\)/);
});
