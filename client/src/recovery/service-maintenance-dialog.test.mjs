import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../components/system/ServiceMaintenanceDialog.tsx', import.meta.url), 'utf8');
const panelShell = fs.readFileSync(new URL('../components/ui/PanelShell.tsx', import.meta.url), 'utf8');
const globalStyles = fs.readFileSync(new URL('../styles/global-base.css', import.meta.url), 'utf8');

test('环境异常时维护面板提供受控修复入口和确认说明', () => {
  assert.match(source, /repair_environment/);
  assert.match(source, /不会停止或自动重启当前正式服务/);
  assert.match(source, /npm run setup/);
  assert.match(source, /data-setup-operation-time/);
  assert.match(source, /环境修复开始于/);
});
const sidebar = fs.readFileSync(new URL('../components/layout/Sidebar.tsx', import.meta.url), 'utf8');
const userMenu = fs.readFileSync(new URL('../components/layout/UserMenu.tsx', import.meta.url), 'utf8');
test('服务维护界面将全部服务与启动器重启收进高级操作', () => {
  assert.match(source, /restart_frontend/);
  assert.match(source, /restart_backend/);
  assert.match(source, /restart_relay/);
  assert.match(source, /const otherActions = \(\['restart_frontend', 'restart_backend'\]/);
  assert.match(source, /data-service-maintenance-advanced/);
  assert.match(source, /<details/);
  assert.match(source, /重启全部服务与启动器/);
  assert.doesNotMatch(source, /restart_codex|upgrade_codex|setup_and_restart/);
});
test('服务维护适配移动底部面板、安全区和主题变量', () => {
  assert.match(source, /<PanelShell/);
  assert.match(source, /size="operations"/);
  assert.match(source, /env\(safe-area-inset-bottom\)/);
  assert.match(panelShell, /panel-shell-layer/);
  assert.match(globalStyles, /var\(--color-overlay-surface\)/);
  assert.match(globalStyles, /\.panel-shell-layer[\s\S]*align-items: flex-end/);
  assert.match(source, /min-h-11/);
});
test('服务操作期间展示统一动态进度和真实阶段文案', () => {
  assert.match(source, /MaintenanceProgress/);
  assert.match(source, /activeStatus\.title/);
  assert.match(source, /setupPhaseDetail \|\| activeStatus\.detail/);
  assert.match(source, /frontendBuildInProgress \? 35_000 : 15_000/);
  assert.match(source, /生产构建通常约 20～30 秒/);
  assert.match(source, /仍在构建并准备安全切换/);
  assert.match(source, /output=\{controller\.operationOutput\}/);
  assert.match(source, /!controller\.submitting && controller\.operationOutput/);
});
test('维护操作命令参考只展示在二次确认 subject 中', () => {
  assert.match(source, /data-service-maintenance-confirm-command/);
  assert.match(source, /function confirmationSubject/);
  assert.match(source, /npm run typecheck → npm exec -- vite build → node --import tsx src\/frontend-gateway\.ts/);
  assert.match(source, /node --import tsx src\/frontend-gateway\.ts/);
  assert.match(source, /vite（监听端点来自 config\/relay\.conf）/);
  assert.match(source, /node --import tsx src\/index\.ts/);
  assert.match(source, /npm run restart/);
  assert.match(source, /npm run setup/);
  assert.doesNotMatch(source, /MaintenanceCommandReference/);
});
test('管理员菜单分别提供 Relay 维护与引擎维护', () => {
  assert.match(userMenu, /<span\b[^>]*>Relay 维护<\/span>/);
  assert.match(source, /: 'Relay 维护'/);
  assert.match(userMenu, />引擎维护</);
  assert.doesNotMatch(userMenu, /user-menu__engine-row/);
  assert.match(sidebar, /EngineMaintenanceDialog/);
});
