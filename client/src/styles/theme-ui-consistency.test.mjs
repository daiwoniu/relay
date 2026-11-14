import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readStyleSource } from './style-source.test-helper.mjs';

const [processSteps, submitControl, directoryPicker, chatView, messageList, sessionSearch, attachments] = await Promise.all([
  readFile(new URL('../components/messages/ProcessSteps.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/chat/ChatInputSubmitControl.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/chat/DirectoryPicker.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/chat/ChatViewPresentation.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/chat/MessageList.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/chat/CurrentSessionSearch.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/messages/MessageAttachmentList.tsx', import.meta.url), 'utf8'),
]);
const styles = readStyleSource();

test('处理过程使用主题表面且普通内层不再叠加实体卡片背景', () => {
  assert.match(styles, /\.process-timeline__panel\s*\{[^}]*background:\s*var\(--color-process-surface\)/s);
  assert.doesNotMatch(processSteps, /process-timeline__panel[^"\n]*bg-\[/);
  assert.match(processSteps, /process-group[^"\n]*bg-transparent/);
  assert.match(processSteps, /process-narrative__details[^"\n]*bg-transparent/);
});

test('主要操作按钮统一使用品牌底色及配对前景色', () => {
  for (const source of [submitControl, directoryPicker]) {
    assert.match(source, /bg-\[var\(--color-primary\)\]/);
    assert.match(source, /text-\[var\(--theme-on-primary\)\]/);
    assert.doesNotMatch(source, /bg-\[var\(--color-text\)\][^'"\n]*text-white/);
  }
});

test('聊天状态反馈和附件表面不绕过主题 token', () => {
  for (const source of [chatView, messageList, sessionSearch, processSteps]) {
    assert.doesNotMatch(source, /(?:text|bg|border)-(?:red|amber)-\d+/);
  }
  assert.doesNotMatch(attachments, /bg-black\//);
  assert.match(attachments, /--color-bg-secondary/);
});
