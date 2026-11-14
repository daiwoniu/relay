import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const component = fs.readFileSync(new URL('NotificationSettingsDialog.tsx', import.meta.url), 'utf8');
const css = readStyleSource();

test('通知设置按设备分页并区分授权与会话任务结束', () => {
  assert.match(component, /桌面端/);
  assert.match(component, /移动端/);
  assert.match(component, /授权请求/);
  assert.match(component, /会话任务结束/);
  assert.match(component, /多端共用/);
});

test('系统通知被拒绝时明确说明是当前浏览器对本站的权限', () => {
  assert.match(component, /账号已开启，但当前浏览器已拒绝本站的系统通知权限/);
  assert.match(component, /当前浏览器已拒绝本站的系统通知权限/);
  assert.doesNotMatch(component, /当前设备已禁止通知/);
});

test('音量范围、步进和调整结束试听符合约定', () => {
  assert.match(component, /type="range" min="10" max="100" step="5"/);
  assert.match(component, /onPointerUp=\{\(\) => void commitVolume\(\)\}/);
  assert.doesNotMatch(component, /onChange=\{[^}]*playNotificationSound/);
});

test('桌面弹窗与移动底部面板使用主题语义变量', () => {
  assert.match(css, /\.notification-settings-dialog[\s\S]*var\(--color-overlay-surface\)/);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.notification-settings-container \{ align-items: flex-end/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});
