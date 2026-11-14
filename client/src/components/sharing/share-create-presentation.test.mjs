import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./ShareCreateDialog.tsx', import.meta.url), 'utf8');

test('创建分享复用共享任务表单原语', () => {
  assert.match(source, /from '..\/ui\/FormControls'/);
  assert.match(source, /<FormField label="分享标题">/);
  assert.match(source, /<FormField label="有效期">/);
  assert.match(source, /<FormField label="自定义截止时间">/);
  assert.match(source, /formControlClassName/);
  assert.match(source, /formSelectClassName/);
  assert.match(source, /formCheckboxCardClassName/);
  assert.match(source, /formCheckboxClassName/);
  assert.match(source, /<FormFeedback message=\{error\} error/);
  assert.match(source, /formActionsClassName/);
  assert.match(source, /primaryFormButtonClassName/);
  assert.match(source, /secondaryFormButtonClassName/);
  assert.match(source, /textFormButtonClassName/);
});

test('创建分享保留风险提示、预览、创建和结果操作流程', () => {
  assert.match(source, /getShareCaution\(includeProcess, expiryOption\)/);
  assert.match(source, /void openPreview\(\)/);
  assert.match(source, /void submit\(\)/);
  assert.match(source, /copyToClipboard\(shareUrl\)/);
  assert.match(source, /window\.open\(shareUrl, '_blank', 'noopener,noreferrer'\)/);
});
