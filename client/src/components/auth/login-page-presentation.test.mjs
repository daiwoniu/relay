import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./LoginPage.tsx', import.meta.url), 'utf8');

test('登录页默认不预填用户名', () => {
  assert.match(source, /const \[username, setUsername\] = useState\(''\);/);
  assert.doesNotMatch(source, /useState\('admin'\)/);
});

test('登录页复用共享字段、反馈和主按钮原语', () => {
  assert.match(source, /from '..\/ui\/FormControls'/);
  assert.match(source, /<FormField label="用户名">/);
  assert.match(source, /<FormField label="密码">/);
  assert.equal(source.match(/className=\{formControlClassName\}/g)?.length, 2);
  assert.doesNotMatch(source, /relay-auth-input/);
  assert.match(source, /<FormFeedback message=\{error\} error/);
  assert.match(source, /primaryFormButtonClassName/);
});
