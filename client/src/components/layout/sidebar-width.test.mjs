import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  readStoredSidebarWidth,
  storeSidebarWidth,
} from './sidebar-width.ts';

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set('relay.sidebar.width.v1', initialValue);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('侧栏宽度限制在桌面端允许范围内', () => {
  assert.equal(clampSidebarWidth(120), SIDEBAR_MIN_WIDTH);
  assert.equal(clampSidebarWidth(360), 360);
  assert.equal(clampSidebarWidth(900), SIDEBAR_MAX_WIDTH);
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_DEFAULT_WIDTH);
});

test('侧栏宽度从本地存储恢复并自动修正越界值', () => {
  assert.equal(readStoredSidebarWidth(createStorage()), SIDEBAR_DEFAULT_WIDTH);
  assert.equal(readStoredSidebarWidth(createStorage('420')), 420);
  assert.equal(readStoredSidebarWidth(createStorage('999')), SIDEBAR_MAX_WIDTH);

  const storage = createStorage();
  storeSidebarWidth(200, storage);
  assert.equal(readStoredSidebarWidth(storage), SIDEBAR_MIN_WIDTH);
});

test('桌面端侧栏接入可访问的宽度拖拽手柄', () => {
  const sidebar = fs.readFileSync(new URL('Sidebar.tsx', import.meta.url), 'utf8');

  assert.match(sidebar, /aria-label="拖动调整侧栏宽度"/);
  assert.match(sidebar, /aria-valuemin=\{SIDEBAR_MIN_WIDTH\}/);
  assert.match(sidebar, /aria-valuemax=\{SIDEBAR_MAX_WIDTH\}/);
  assert.match(sidebar, /style=\{\{[\s\S]*?width: !sidebarOpen && !isMobile \? 0 : isMobile \? 'min\(288px, 82vw\)' : `\$\{sidebarWidth\}px`/);
  assert.match(sidebar, /transform: sidebarSwipe\.translateX === null \? undefined : `translate3d\(\$\{sidebarSwipe\.translateX\}px, 0, 0\)`/);
  assert.match(sidebar, /event\.currentTarget\.focus\(\{ preventScroll: true \}\)/);
});
