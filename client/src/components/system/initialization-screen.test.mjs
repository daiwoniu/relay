import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getInitializationStagePresentation, INITIALIZATION_LOADING_DELAY_MS } from './initialization-screen.ts';

const screenSource = readFileSync(new URL('./InitializationScreen.tsx', import.meta.url), 'utf8');

test('首次全屏加载只保留认证与页面错误状态，不展示虚假步骤', () => {
  assert.deepEqual(getInitializationStagePresentation('auth'), {
    title: '正在启动 Relay…',
    detail: '正在确认当前设备的登录状态',
  });
  assert.deepEqual(getInitializationStagePresentation('page'), {
    title: '正在加载页面',
    detail: '正在准备聊天界面资源',
  });
  assert.equal(INITIALIZATION_LOADING_DELAY_MS, 200);
  assert.match(screenSource, /setTimeout\(\(\) => setVisible\(true\), INITIALIZATION_LOADING_DELAY_MS\)/);
  assert.doesNotMatch(screenSource, /步骤/);
});
