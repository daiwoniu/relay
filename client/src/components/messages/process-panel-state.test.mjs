import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getInitialProcessPanelCollapsed,
  getSearchPreservedExpandedState,
  hasPendingInteraction,
  shouldAutoCollapseProcessPanel,
} from './process-panel-state.ts';

test('实时流程移交完成气泡时自动折叠，即使运行时保留了展开偏好', () => {
  assert.equal(getInitialProcessPanelCollapsed(true, true, false, { panelExpanded: true, panelSettled: false }), true);
});

test('没有最终回复时仍展开，历史消息手动展开偏好和运行时偏好继续保留', () => {
  assert.equal(getInitialProcessPanelCollapsed(true, true, true, { panelExpanded: true, panelSettled: false }), false);
  assert.equal(getInitialProcessPanelCollapsed(true, true, false, { panelExpanded: true, panelSettled: true }), false);
  assert.equal(getInitialProcessPanelCollapsed(true, true, false, { panelExpanded: true }), false);
  assert.equal(getInitialProcessPanelCollapsed(false, false, false, { panelExpanded: false, panelSettled: false }), true);
  assert.equal(getInitialProcessPanelCollapsed(true, true, false), true);
  assert.equal(getInitialProcessPanelCollapsed(false, false, false), false);
});

test('实时处理进入终态时自动折叠处理过程', () => {
  assert.equal(shouldAutoCollapseProcessPanel(false, true), true);
});

test('初始历史消息和未结束消息不触发自动折叠', () => {
  assert.equal(shouldAutoCollapseProcessPanel(true, true), false);
  assert.equal(shouldAutoCollapseProcessPanel(false, false), false);
  assert.equal(shouldAutoCollapseProcessPanel(true, false), false);
});

test('搜索自动展开的过程在退出搜索后保持展开', () => {
  assert.equal(getSearchPreservedExpandedState(false, false, false, true), true);
  assert.equal(getSearchPreservedExpandedState(true, false, true, false), true);
});

test('非搜索状态仍跟随默认展开配置', () => {
  assert.equal(getSearchPreservedExpandedState(true, false, false, false), false);
  assert.equal(getSearchPreservedExpandedState(false, true, false, false), true);
});

test('只有仍待处理的 interaction 才要求历史过程面板默认展开', () => {
  assert.equal(hasPendingInteraction([
    { type: 'interaction', status: 'completed' },
    { type: 'commandExecution', status: 'completed' },
  ]), false);
  assert.equal(hasPendingInteraction([
    { type: 'interaction', status: 'in_progress' },
  ]), true);
  assert.equal(hasPendingInteraction([
    { type: 'interaction', status: 'incomplete' },
  ]), false);
});

test('流式 thought 过程默认折叠，终态过程可默认展开', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./ProcessSteps.tsx', import.meta.url), 'utf8');
  assert.match(source, /defaultExpandedNarrativeItemId = processTimeline && settled/);
  assert.match(source, /processContentDetail[^\n]*defaultExpanded=\{settled\}/);
});
