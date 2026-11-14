import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./PasswordChangeRequired.tsx', import.meta.url), 'utf8');

test('首次改密复用共享字段、反馈和操作按钮原语', () => {
  assert.match(source, /from '..\/ui\/FormControls'/);
  assert.equal(source.match(/<FormField /g)?.length, 3);
  assert.match(source, /formControlClassName/);
  assert.match(source, /<FormFeedback message=\{error\} error/);
  assert.match(source, /primaryFormButtonClassName/);
  assert.match(source, /textFormButtonClassName/);
  assert.doesNotMatch(source, /const inputClass =/);
});
