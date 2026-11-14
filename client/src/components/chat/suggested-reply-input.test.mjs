import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const inputSource = fs.readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
const viewSource = [
  './ChatView.tsx',
  './ChatViewPresentation.tsx',
].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');

test('当前会话候选传入输入框且不修改消息协议', () => {
  assert.match(viewSource, /selectSuggestedReplyCandidate\(currentMessages, isCurrentSessionRunning\)/);
  assert.match(viewSource, /suggestedReply,/);
  assert.match(inputSource, /suggestedReply\?: SuggestedReplyCandidate \| null/);
});

test('建议回复使用独立会话状态并只在空草稿时预填', () => {
  assert.match(inputSource, /getSuggestedReplyDraftKey\(draftKey\)/);
  assert.match(inputSource, /readSuggestedReplyDraftState\(sessionStorage, suggestedReplyDraftKey\)/);
  assert.match(inputSource, /resolveSuggestedReplyPrefill/);
  assert.match(inputSource, /if \(resolved\.shouldPersistDraft\) writeChatDraft/);
  assert.match(inputSource, /writeSuggestedReplyDraftState\(sessionStorage, suggestedReplyDraftKey, resolved\.state\)/);
});

test('编辑、清空、便签和成功发送都会接管或清理建议状态', () => {
  assert.match(inputSource, /const dismissActiveSuggestedReply =/);
  assert.match(inputSource, /const setInput = \(value: string\) => \{\s+dismissActiveSuggestedReply\(\)/);
  assert.match(inputSource, /const handleClearInput = \(\) => \{\s+setInput\(''\)/);
  assert.match(inputSource, /const handleInsertLocalNote[\s\S]*setInput\(nextInput\)/);
  assert.match(inputSource, /writeSuggestedReplyDraftState\(sessionStorage, suggestedReplyDraftKey, null\)/);
});

test('未编辑自动建议首次聚焦或点击时全选且用户移动光标后恢复普通行为', () => {
  assert.match(inputSource, /suggestedReplySelectionPendingRef/);
  assert.match(inputSource, /const selectSuggestedReplyOnce =/);
  assert.match(inputSource, /\.select\(\)/);
  assert.match(inputSource, /onPointerDown=\{handleSuggestedReplyPointerDown\}/);
  assert.match(inputSource, /onFocus=\{handleSuggestedReplyFocus\}/);
  assert.match(inputSource, /onSelect=\{handleSuggestedReplySelectionChange\}/);
  assert.match(inputSource, /consumeSuggestedReplySelection/);
  assert.match(inputSource, /writeSuggestedReplyDraftState\(sessionStorage, suggestedReplyDraftKey, selected\)/);
  assert.match(inputSource, /dismissActiveSuggestedReply\(\)/);
});

test('活动建议显示可替换提示，普通输入保留 AI 声明', () => {
  assert.match(inputSource, /suggestedReplyActive \? '已填入建议回复，点击输入框可全选替换' : '内容由 AI 生成，请核实重要信息'/);
});
