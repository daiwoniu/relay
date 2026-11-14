import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const assistantSource = fs.readFileSync(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');
const referenceSource = fs.readFileSync(new URL('./CodexFileReference.tsx', import.meta.url), 'utf8');
const previewHookSource = fs.readFileSync(new URL('./useFilePreview.ts', import.meta.url), 'utf8');
const markdownFoundationStyles = fs.readFileSync(new URL('../../styles/markdown-foundation.css', import.meta.url), 'utf8');

test('最终 Markdown 接入 Codex 指令插件和统一文件引用组件', () => {
  assert.match(assistantSource, /\? \[remarkGfm, remarkRelaxedStrong, remarkCodexFileDirectives, remarkHtmlBreak\]\s*: \[remarkGfm, remarkRelaxedStrong, remarkHtmlBreak\]/);
  assert.match(assistantSource, /decodeCodexFileReference\(href\)/);
  assert.match(assistantSource, /<CodexFileReference reference=\{codexReference\} projectPath=\{projectPath\} readOnly=\{readOnly\}/);
  assert.match(assistantSource, /codex-inline-vis\|::artifact-template\|:codex-file-citation/);
});

test('统一文件引用支持键盘访问和只读降级', () => {
  assert.match(referenceSource, /role="button"/);
  assert.match(referenceSource, /tabIndex=\{0\}/);
  assert.match(referenceSource, /if \(readOnly\) return <span/);
  assert.match(referenceSource, /preferredMode: reference\.preferredMode/);
  assert.match(referenceSource, /resolveCodexFileReferencePathResult\(reference\.path, projectPath\)/);
  assert.match(referenceSource, /aria-disabled="true"/);
  assert.match(referenceSource, /resolution\.reason/);
  assert.match(referenceSource, /allowHtmlScripts: reference\.kind === 'visualization'/);
});

test('Markdown 渲染内容允许手动框选文件引用和行内代码', () => {
  assert.doesNotMatch(assistantSource, /md-link-file[^"\n]*select-none/);
  assert.doesNotMatch(referenceSource, /md-link-file[^"\n]*select-none/);
  assert.match(markdownFoundationStyles, /\.assistant-message \.markdown-body,\s*\.assistant-message \.markdown-body \*\s*\{[^}]*user-select:\s*text\s*!important;/s);
  assert.doesNotMatch(markdownFoundationStyles, /(?:^|\n)\.markdown-body,\s*\n\.markdown-body \*/);
  assert.match(assistantSource, /hasExpandedSelectionWithin\(e\.currentTarget\)/);
  assert.match(referenceSource, /hasExpandedSelectionWithin\(event\.currentTarget\)/);
});

test('文件预览只在首次打开 HTML 标签时采用首选模式', () => {
  assert.match(previewHookSource, /existing\?\.htmlPreviewMode \?\? preferredMode/);
  assert.match(previewHookSource, /options\.preferredMode \?\? 'source'/);
  assert.match(previewHookSource, /existing\?\.htmlPreviewScriptsEnabled \?\? options\.allowHtmlScripts === true/);
});
