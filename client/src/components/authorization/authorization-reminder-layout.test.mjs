import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

test('授权提醒同时展示列表并提供关闭后的恢复入口', () => {
  const card = fs.readFileSync(new URL('AuthorizationReminderCard.tsx', import.meta.url), 'utf8');
  const layer = fs.readFileSync(new URL('AuthorizationReminderLayer.tsx', import.meta.url), 'utf8');

  assert.match(card, /authorization-reminder-list/);
  assert.match(card, /props\.orderedIds\.map/);
  assert.doesNotMatch(card, /上一个授权请求|下一个授权请求/);
  assert.match(layer, /authorization-reminder-trigger/);
  assert.match(layer, /onClick=\{state\.showCard\}/);
  assert.match(card, /authorization-reminder-batch-action--primary/);
  assert.match(card, /authorization-reminder-batch-action__count/);
  assert.match(card, /McpElicitationForm/);
  assert.match(card, />继续</);
  assert.doesNotMatch(card, />会话标题</);
  assert.doesNotMatch(card, />请求摘要</);
  assert.match(card, /expanded \? 'whitespace-normal break-words' : 'truncate'/);
  assert.match(card, /authorization-reminder-item__purpose--expanded/);
  assert.match(card, /min-w-0 flex-1 text-\[13px\]/);
  assert.match(card, /shrink-0 text-\[10px\] text-\[var\(--color-status-warning\)\]/);
  assert.match(card, /sm:hidden">会话：/);
  assert.match(card, /hidden sm:inline">来源会话：/);
  assert.match(card, /model\.purpose/);
  assert.match(card, /model\.canDecline/);
  assert.match(card, /model\.showAcceptForSession/);
  assert.match(card, /!isMcp && model\.canDecline/);
  assert.match(card, /isMcp && <button.*respond\('decline'\)/);
  assert.match(card, /该请求未提供可用的授权操作，当前无法继续。请停止本轮后重试。/);
  assert.match(card, /respond\('submit'/);
  assert.match(card, /approval.kind === 'async_question' && <button[^\n]+respond\('cancel'\)/);
  assert.doesNotMatch(card, /取消并中断本轮/);
  assert.doesNotMatch(card, /onBatchStart\('reject'\)/);
  assert.doesNotMatch(card, /batchDeclineCount|batchCancelOnlyCount/);
  assert.match(card, /前往会话/);
  assert.doesNotMatch(card, /\{approval\.summary\}<\/span>/);
  assert.match(card, /authorization-reminder-item__purpose/);
  const styles = readStyleSource();
  assert.match(styles, /\.authorization-reminder-item__purpose \{[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(styles, /\.authorization-reminder-item__purpose--expanded \{[\s\S]*?-webkit-line-clamp: unset;/);
});

test('消息授权面板隐藏 cancel 并在没有可用操作时提示停止本轮', () => {
  const panel = fs.readFileSync(new URL('../messages/InteractionPanel.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(panel, /approvalAvailability\.cancel/);
  assert.doesNotMatch(panel, /respond\('cancel'\).*取消并中断本轮/);
  assert.match(panel, /该请求未提供可用的授权操作，当前无法继续。请停止本轮后重试。/);
  assert.match(panel, /approvalAvailability\.acceptForSession/);
  assert.match(panel, /approvalAvailability\.decline/);
  assert.match(panel, /approvalAvailability\.accept/);
});

test('普通授权与 MCP 在消息面板和通知浮层中都优先展示继续操作', () => {
  const card = fs.readFileSync(new URL('AuthorizationReminderCard.tsx', import.meta.url), 'utf8');
  const panel = fs.readFileSync(new URL('../messages/InteractionPanel.tsx', import.meta.url), 'utf8');
  const assertOrdered = (source, markers, message) => {
    const positions = markers.map((marker) => source.indexOf(marker));
    assert.ok(positions.every((position) => position >= 0), `${message}：操作不存在`);
    assert.ok(positions.every((position, index) => index === 0 || positions[index - 1] < position), message);
  };

  assertOrdered(card, ['!isMcp && model.canAccept', '!isMcp && model.showAcceptForSession', '!isMcp && model.canDecline'], '通知浮层普通授权应允许、本会话允许、再拒绝');
  assertOrdered(card, ["isMcp && (expanded || mcpDirectSubmission)", "isMcp && <button"], '通知浮层 MCP 应先继续再拒绝');

  const panelMcpStart = panel.lastIndexOf("kind === 'mcp_elicitation'");
  const panelApprovalStart = panel.indexOf("kind === 'unsupported_request'", panelMcpStart);
  assert.ok(panelMcpStart >= 0 && panelApprovalStart > panelMcpStart, '消息面板应包含独立的 MCP 与普通授权分支');
  const panelMcp = panel.slice(panelMcpStart, panelApprovalStart);
  assertOrdered(panelMcp, ["respond('submit'", "respond('decline')"], '消息面板 MCP 应按继续、拒绝排列');

  const panelApproval = panel.slice(panelApprovalStart);
  assertOrdered(panelApproval, ['approvalAvailability.accept &&', 'approvalAvailability.acceptForSession &&', 'approvalAvailability.decline &&'], '消息面板普通授权应按允许一次、本会话允许、拒绝排列');
});

test('移动端通知面板收窄且列表独立滚动以保留批量操作区', () => {
  const styles = readStyleSource();

  assert.match(styles, /\.authorization-reminder-layer \{[\s\S]*?width: min\(25rem,/);
  assert.match(styles, /width: min\(20rem,/);
  assert.match(styles, /\.authorization-reminder-list \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?overflow-x: hidden;/);
  assert.match(styles, /\.authorization-reminder-list > \[role='listitem'\] \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;/);
  assert.match(styles, /\.authorization-reminder-item \{[\s\S]*?min-width: 0;/);
  assert.doesNotMatch(styles, /\.authorization-reminder-item \{[\s\S]*?max-width: 18\.5rem;/);
  assert.match(styles, /\.authorization-reminder-card \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
  assert.match(styles, /\.authorization-reminder-list \{[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.authorization-reminder-batch \{[\s\S]*?flex: 0 0 auto;/);
});
