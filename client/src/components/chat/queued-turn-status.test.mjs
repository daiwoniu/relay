import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveQueuedTurnUiState } from './queued-turn-status.ts';
import { getComposerStatusNotice } from './composer-status-notice.ts';

const base = { queueId: 'q1', sessionId: 's1', engineId: 'codex', resourceKey: 'codex:default', label: 'Codex', state: 'queued', position: 3, activeTurns: 2, maxActiveTurns: 2, cooldownUntil: 31_000, createdAt: 1 };

test('真实 queued 状态只锁定输入框，不提供排队卡展示数据', () => {
  assert.deepEqual(resolveQueuedTurnUiState(base, false, { now: 1_000 }), { isQueued: true, isWaiting: true });
  assert.deepEqual(
    resolveQueuedTurnUiState({ ...base, state: 'claimed', position: null }, true),
    { isQueued: false, isWaiting: false },
  );
});

test('队列快照尚未到达时回退到会话 queued 状态', () => {
  assert.deepEqual(resolveQueuedTurnUiState(null, true), { isQueued: true, isWaiting: false });
  assert.deepEqual(resolveQueuedTurnUiState(null, false), { isQueued: false, isWaiting: false });
});

test('有可用槽位的内部 queued 不展示，只有真实容量、冷却或 probe 阻塞才展示', () => {
  const immediatelyClaimable = { ...base, position: 1, activeTurns: 0, maxActiveTurns: 2, cooldownUntil: null };
  assert.deepEqual(resolveQueuedTurnUiState(immediatelyClaimable, true), { isQueued: true, isWaiting: false });
  assert.deepEqual(resolveQueuedTurnUiState({ ...immediatelyClaimable, activeTurns: 2 }, true), { isQueued: true, isWaiting: true });
  assert.deepEqual(resolveQueuedTurnUiState({ ...immediatelyClaimable, cooldownUntil: 2_000 }, true, { now: 1_000 }), { isQueued: true, isWaiting: true });
  assert.deepEqual(resolveQueuedTurnUiState(immediatelyClaimable, true, { probeInProgress: true }), { isQueued: true, isWaiting: true });
});

test('输入区只显示简短排队提示且不恢复上方排队卡', async () => {
  const [chatView, chatInput] = await Promise.all([
    readFile(new URL('./ChatView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8'),
  ]);
  assert.equal(getComposerStatusNotice({
    attachmentNotice: null,
    isAwaitingAction: false,
    engineStatusNotice: null,
    isQueued: true,
    submissionPhase: 'idle',
    deletingAttachment: false,
    hasUnreadyAttachments: false,
  })?.message, '消息已排队');
  assert.match(chatInput, /composerStatusNotices = getComposerStatusNotices\(\{[\s\S]*isQueued: isQueueWaiting/);
  assert.match(chatInput, /useDelayedComposerStatusNotices\(composerStatusNotices, attachmentDraftKey\)/);
  assert.doesNotMatch(chatInput, /可在上方取消/);
  assert.doesNotMatch(chatView, /QueuedTurnStatus|visibleQueue/);
});

test('排队时在输入框内保留取消入口', async () => {
  const [chatView, chatInput, submitControl] = await Promise.all([
    readFile(new URL('./ChatView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ChatInputSubmitControl.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(chatView, /cancelQueuedTurn/);
  assert.match(chatInput, /onCancelQueued=\{onCancelQueued\}/);
  assert.match(submitControl, /if \(isQueued\)[\s\S]*aria-label=\{isCancellingQueued \? '正在取消排队' : '取消排队'\}/);
  assert.match(submitControl, /if \(isQueued\)[\s\S]*\{sendControl\}/);
});

test('排队提示与取消入口延迟 500ms，输入锁定仍立即生效', async () => {
  const [chatInput, chatView] = await Promise.all([
    readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ChatView.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(chatInput, /import \{ TRANSIENT_NOTICE_DELAY_MS, useDelayedComposerStatusNotices \}/);
  assert.match(chatInput, /window\.setTimeout\(\(\) => \{[\s\S]*setQueuedPresentationSessionId\(sessionId\)[\s\S]*TRANSIENT_NOTICE_DELAY_MS/);
  assert.match(chatInput, /\}, \[isQueueWaiting, sessionId\]\)/);
  assert.match(chatInput, /composerStatusNotices = getComposerStatusNotices\(\{[\s\S]*isQueued: isQueueWaiting/);
  assert.match(chatInput, /<ChatInputSubmitControl[\s\S]*?isQueued=\{queuedPresentationVisible\}/);
  assert.match(chatInput, /readOnly=\{isSubmitting\}/);
  assert.match(chatView, /isQueueWaiting: queuedTurnUi\.isWaiting/);
});
