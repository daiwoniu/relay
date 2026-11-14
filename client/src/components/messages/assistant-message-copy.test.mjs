import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getRenderedMessageCopyText } from './message-copy-text.ts';

const assistantSource = await readFile(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');

test('Markdown 视图只从助手回复正文读取复制文本', () => {
  assert.match(assistantSource, /const contentRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(assistantSource, /showSource\s*\? content\s*:\s*getRenderedMessageCopyText\(contentRef\.current\) \?\? content/);
  assert.doesNotMatch(assistantSource, /contentRef\.current\?\.innerText/);
  assert.doesNotMatch(assistantSource, /className=\{`message-bubble[^\n]*ref=\{contentRef\}/);
  assert.match(assistantSource, /<div ref=\{contentRef\} data-search-content className="markdown-body/);
});

test('源码视图仍复制原始 Markdown', () => {
  assert.match(assistantSource, /const textToCopy = showSource\s*\? content/);
});

test('渲染文本提取时排除正文内工具栏并恢复节点状态', () => {
  const controls = [{ hidden: false }, { hidden: true }];
  const contentElement = {
    querySelectorAll(selector) {
      assert.equal(selector, '[data-message-copy-exclude]');
      return controls;
    },
    get innerText() {
      return controls.every((control) => control.hidden) ? '回复正文\n代码内容' : 'typescript\n复制\n回复正文\n代码内容';
    },
  };

  assert.equal(getRenderedMessageCopyText(contentElement), '回复正文\n代码内容');
  assert.deepEqual(controls.map((control) => control.hidden), [false, true]);
  assert.match(assistantSource, /data-message-copy-exclude/);
});

test('读取渲染文本失败时也恢复被排除节点', () => {
  const control = { hidden: false };
  const contentElement = {
    querySelectorAll() {
      return [control];
    },
    get innerText() {
      throw new Error('读取失败');
    },
  };

  assert.throws(() => getRenderedMessageCopyText(contentElement), /读取失败/);
  assert.equal(control.hidden, false);
});

test('没有最终回复正文时不显示复制和源码按钮', () => {
  assert.match(assistantSource, /const showDirectCopy = Boolean\(displayContent\) && \(!mobile \|\| readOnly\)/);
  assert.match(assistantSource, /\{showDirectCopy && \(\s*<ActionButton onClick=\{handleCopy\}/);
  assert.match(assistantSource, /if \(!readOnly && displayContent\) \{\s*messageActionItems\.push\(\{\s*key: 'source'/);
  assert.match(assistantSource, /const showMessageActions = messageActionItems\.length > 0/);
  assert.doesNotMatch(assistantSource, /\{\(displayContent \|\| processContent\) && <div/);
});
