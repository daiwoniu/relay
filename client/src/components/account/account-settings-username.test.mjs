import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const component = fs.readFileSync(new URL('./AccountSettingsDialog.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../../api/auth.ts', import.meta.url), 'utf8');

test('账号设置提供验证当前密码的登录名修改表单', () => {
  assert.match(component, /Field label="新登录名"/);
  assert.match(component, /pattern="\[A-Za-z0-9\._-\]\+"/);
  assert.match(component, /autoComplete="username"/);
  assert.match(component, /Field label="确认当前密码"/);
  assert.match(component, /changeUsername\(username\.trim\(\), usernamePassword\)/);
  assert.match(component, /其他设备已退出/);
  assert.match(api, /requestJson\('\/api\/auth\/change-username'/);
});
