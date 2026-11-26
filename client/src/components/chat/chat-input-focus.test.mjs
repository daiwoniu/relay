import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const inputSource = [
  './ChatInput.tsx',
  './ChatInputSubmitControl.tsx',
].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');

test('消息发送成功或失败并解锁输入后恢复输入框焦点', () => {
  assert.match(inputSource, /let shouldRestoreInputFocus = false/);
  assert.match(inputSource, /if \(attachmentDraftKeyRef\.current === submissionDraftKey\) shouldRestoreInputFocus = true;\s*if \(!accepted\) return/);
  assert.match(inputSource, /setSubmissionState\(\(current\) => clearSubmissionState\(current, submissionDraftKey\)\);\s*if \(shouldRestoreInputFocus\) requestInputFocus\('send-finished', null\)/);
  assert.match(inputSource, /textarea\.focus\(\)/);
});

test('用户已把焦点移出输入区时不强行抢回焦点', () => {
  assert.match(inputSource, /const focusMovedOutsideExpectedFlow = activeElement[\s\S]*?activeElement !== expectedSource[\s\S]*?activeElement !== textarea/);
  assert.doesNotMatch(inputSource, /!form\?\.contains\(activeElement\)/);
  assert.match(inputSource, /if \(!document\.hasFocus\(\) \|\| !textarea \|\| textarea\.disabled \|\| focusMovedOutsideExpectedFlow\) return/);
});

test('明确输入动作支持在原始用户手势内同步聚焦', () => {
  assert.match(inputSource, /registerComposerFocusHandler\(handleComposerFocusRequest\)/);
  assert.match(inputSource, /const handleComposerFocusRequest = useCallback\(\(request: ComposerFocusRequest\) => tryFocusInput/);
  assert.match(inputSource, /const focusedSynchronously = tryFocusInput\('project-selected', sourceElement\)/);
  assert.match(inputSource, /const focusedSynchronously = tryFocusInput\('attachment-selected', sourceElement\)/);
  assert.match(inputSource, /readOnly=\{isSubmitting\}/);
  assert.doesNotMatch(inputSource, /disabled=\{isAwaitingAction\}/);
  assert.match(inputSource, /engineUnavailable=\{engineUnavailable\}/);
  assert.match(inputSource, /if \(isQueued\)[\s\S]*onClick=\{onCancelQueued\}/);
  assert.match(inputSource, /disabled=\{engineUnavailable \|\| engineSelectionRequired \|\|/);
  assert.match(inputSource, /type="submit"[\s\S]*?onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/);
});

test('停止与附件流程复用统一输入框聚焦调度', () => {
  const chatSource = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');
  assert.match(chatSource, /if \(!isMobile\) requestComposerFocus\('stop-finished'\)/);
  assert.match(inputSource, /requestInputFocus\('attachment-selected', sourceElement\)/);
  assert.match(inputSource, /requestInputFocus\('attachment-cancelled', sourceElement\)/);
  assert.match(inputSource, /requestInputFocus\('project-selected', sourceElement\)/);
});

test('旧焦点请求不会因设备断点变化重复执行', () => {
  assert.match(inputSource, /focusRequest\.id <= lastHandledFocusRequestIdRef\.current/);
  assert.match(inputSource, /lastHandledFocusRequestIdRef\.current = focusRequest\.id/);
});
