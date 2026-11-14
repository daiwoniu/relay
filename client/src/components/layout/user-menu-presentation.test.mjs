import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const component = fs.readFileSync(new URL('./UserMenu.tsx', import.meta.url), 'utf8');
const sidebar = fs.readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const css = readStyleSource();

test('用户菜单按账号、个人、管理、系统管理与会话形成稳定层级', () => {
  assert.match(component, /进入设置中心/);
  assert.match(component, /aria-label="个人"/);
  assert.match(component, /aria-label="管理"/);
  assert.match(component, />账号管理</);
  assert.doesNotMatch(component, />AI 情报|>任务工作台|>资讯管理|>用户资源/);
  assert.match(component, /\(showServiceMaintenance \|\| user !== null\) && <div className="user-menu__section" aria-label="系统管理">/);
  assert.match(component, /aria-label="会话"/);
  assert.match(component, /showServiceMaintenance && <button/);
  assert.match(component, /engineSummary\.engines\.filter\(\(engine\) => engine\.readiness === 'ready'\)/);
  assert.match(component, /Relay v\{__RELAY_VERSION__\}/);
});

test('Sidebar 通过独立用户菜单组件连接既有操作', () => {
  assert.match(sidebar, /<UserMenu/);
  assert.match(sidebar, /onOpenSettings=\{\(\) => \{ restoreMinimizedPanel\('account-settings-title'\); setAccountSettingsOpen\(true\); \}\}/);
  assert.match(sidebar, /<SidebarWorkbench[^\n]*onOpenUserResources=\{\(\) => \{ restoreMinimizedPanel\('user-resource-dialog-title'\); setUserResourceDialogOpen\(true\); \}\}/);
  assert.match(sidebar, /onOpenAccountManagement=\{\(\) => \{ restoreMinimizedPanel\('account-management-title'\); setAccountManagementOpen\(true\); \}\}/);
  assert.match(sidebar, /onOpenServiceMaintenance=\{\(\) => \{ restoreMinimizedPanel\('service-maintenance-title'\); setServiceMaintenanceOpen\(true\); \}\}/);
  assert.match(sidebar, /onOpenEngineMaintenance=\{openEngineMaintenance\}/);
});

test('菜单项在桌面与移动端具有明确焦点和触控尺寸', () => {
  assert.match(css, /\.user-menu__item[\s\S]*min-height: 2\.5rem/);
  assert.match(css, /\.user-menu__item:focus-visible/);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.user-menu__item \{ min-height: 2\.75rem/);
});

test('移动端用户菜单使用贴底面板并保持退出入口可达', () => {
  assert.match(component, /mobilePresentation=\{mobile \? 'sheet' : 'floating'\}/);
  assert.match(component, /className="user-menu__scroll-region"/);
  assert.match(component, /user-menu__section user-menu__section--session/);
  assert.match(css, /\.user-menu\s*\{[\s\S]*display: flex[\s\S]*max-height: inherit[\s\S]*flex-direction: column/);
  assert.match(css, /\.user-menu__scroll-region\s*\{[\s\S]*overflow-y: auto/);
  assert.match(css, /\.user-menu__section--session\s*\{[\s\S]*flex: none/);
});

test('管理入口保留账号管理图标', () => {
  assert.match(component, /if \(type === 'accounts'\)[\s\S]*circle cx="13\.3" cy="12\.7" r="2\.1"/);
});
