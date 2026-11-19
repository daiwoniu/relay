import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [input, dialogs] = await Promise.all([
  readFile(new URL('ChatInput.tsx', import.meta.url), 'utf8'),
  readFile(new URL('ChatInputDialogs.tsx', import.meta.url), 'utf8'),
]);

test('桌面和移动端点击多行输入框清空按钮时先确认', () => {
  assert.match(input, /onClick=\{\(\) => setClearConfirmOpen\(true\)\}/);
  assert.match(input, /clearConfirmOpen=\{clearConfirmOpen\}/);
  assert.match(dialogs, /<ConfirmDialog[\s\S]*?open=\{clearConfirmOpen\}[\s\S]*?title="清空输入内容？"[\s\S]*?onCancel=\{onCancelClear\}[\s\S]*?onConfirm=\{onConfirmClear\}/);
  assert.doesNotMatch(input, /isMobile\s*\?\s*setClearConfirmOpen/);
});

test('取消保留草稿，确认后才清空，切换草稿时关闭旧确认', () => {
  const clearHandler=input.match(/const handleClearInput = \(\) => \{([^]*?)\};/)?.[1];
  assert.ok(clearHandler,'确认清空主点存在');
  assert.match(clearHandler, /setInput\(''\);\s*setClearConfirmOpen\(false\);\s*textareaRef\.current\?\.focus\(\);/);
  const cancelHandler=input.match(/onCancelClear=\{\(\) => \{([^]*?)\}\}/)?.[1];
  assert.ok(cancelHandler);assert.match(cancelHandler,/setClearConfirmOpen\(false\)/);assert.doesNotMatch(cancelHandler,/setInput\(/);
  assert.match(input, /onConfirmClear=\{handleClearInput\}/);
  assert.match(input, /useEffect\(\(\) => \{\s*setClearConfirmOpen\(false\);\s*\}, \[draftKey\]\);/);
});
