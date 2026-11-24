import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  LOCAL_NOTE_EDITOR_LINE_HEIGHT,
  LOCAL_NOTE_EDITOR_MAX_LINES,
  LOCAL_NOTES_PANEL_MAX_WIDTH,
  LOCAL_NOTES_PANEL_MIN_WIDTH,
  getLocalNoteEditorSize,
  getLocalNoteInitialEditorHeight,
  getLocalNotesPanelWidth,
} from './local-notes-layout.ts';

test('编辑框最多显示八行并在超出后内部滚动', () => {
  const maxHeight = LOCAL_NOTE_EDITOR_LINE_HEIGHT * LOCAL_NOTE_EDITOR_MAX_LINES;

  assert.deepEqual(getLocalNoteEditorSize(72), { height: 72, scrollable: false });
  assert.deepEqual(getLocalNoteEditorSize(maxHeight + 24), { height: maxHeight, scrollable: true });
});

test('进入编辑态时可复用查看态实际高度', () => {
  assert.deepEqual(getLocalNoteEditorSize(96, 72), { height: 72, scrollable: true });
});

test('长便签再次进入编辑态时外层高度也限制为八行', () => {
  const maxHeight = LOCAL_NOTE_EDITOR_LINE_HEIGHT * LOCAL_NOTE_EDITOR_MAX_LINES;

  assert.equal(getLocalNoteInitialEditorHeight(maxHeight + 120), maxHeight);
  assert.equal(getLocalNoteInitialEditorHeight(72), 72);
});

test('便签组件把受限高度同时用于输入框初始高度和外层占位', () => {
  const source = fs.readFileSync(new URL('./LocalNotesControl.tsx', import.meta.url), 'utf8');

  assert.match(source, /const editorHeight = getLocalNoteInitialEditorHeight\(viewHeight\)/);
  assert.match(source, /initialEditorHeightRef\.current = editorHeight/);
  assert.match(source, /setEditingViewHeight\(editorHeight\)/);
});

test('空便签使用最小面板宽度', () => {
  assert.equal(getLocalNotesPanelWidth(['']), LOCAL_NOTES_PANEL_MIN_WIDTH);
});

test('面板宽度跟随最长一行内容增长', () => {
  const shortWidth = getLocalNotesPanelWidth(['短内容']);
  const longWidth = getLocalNotesPanelWidth(['第一行\n' + '这是一行明显更长的便签内容'.repeat(2)]);

  assert.ok(longWidth > shortWidth);
});

test('超长内容不超过最大面板宽度', () => {
  assert.equal(getLocalNotesPanelWidth(['很长'.repeat(100)]), LOCAL_NOTES_PANEL_MAX_WIDTH);
});
