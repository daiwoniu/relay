import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const component = fs.readFileSync(new URL('./UserMenu.tsx', import.meta.url), 'utf8');
const sidebar = fs.readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const administration = fs.readFileSync(new URL('./AdministrationCenter.tsx', import.meta.url), 'utf8');
const css = readStyleSource();

test('头像菜单区分个人操作与管理员入口', () => {
  assert.match(component, />设置中心</);
  assert.match(component, />我的分享</);
  assert.match(component, />回收站</);
  assert.match(component, /user\?\.role === 'admin'[\s\S]*全部账号/);
  assert.match(component, /user\?\.role === 'admin'[\s\S]*管理中心/);
  assert.doesNotMatch(component, />飞书管理|>引擎维护|>Relay 维护|>任务工作台/);
  assert.match(component, /Relay v\{__RELAY_VERSION__\}/);
});

test('Sidebar 通过独立用户菜单组件连接既有操作', () => {
  assert.match(sidebar, /<UserMenu/);
  assert.match(sidebar, /onOpenSettings=\{\(\) => openSidebarPanel\('account-settings-title', setAccountSettingsOpen\)\}/);
  assert.match(sidebar, /<SidebarWorkbench[^\n]*onOpenUserResources=\{\(\) => openSidebarPanel\('user-resource-dialog-title', setUserResourceDialogOpen\)\}/);
  assert.match(sidebar, /onOpenAdministration=\{\(\) => setAdministrationOpen\(true\)\}/);
  assert.match(sidebar, /user\?\.role === 'admin' && <>\s*<AdministrationCenter/);
  assert.match(sidebar, /openSidebarPanel\(destination\.id, destination\.open\)/);
  assert.match(administration, /平台管理[\s\S]*运行与维护/);
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

test('管理中心使用一致的目的地图标并标注新标签页', () => {
  assert.match(administration, /MenuDestinationIcon external=\{external\}/);
  assert.match(administration, /target="_blank" rel="noopener noreferrer"/);
  assert.match(administration, /（新标签页打开）/);
  assert.match(administration, /minimizable=\{false\}/);
});

test('管理中心各操作统一左对齐，首组去掉重复分隔并允许移动贴底面板随内容收高', () => {
  assert.match(css, /\.administration-center \.user-menu__item\s*\{\s*text-align: left/);
  assert.match(css, /\.administration-center \.user-menu__section:first-child\s*\{[^}]*border-top: 0/);
  assert.match(administration, /mobileFitContent/);
});
