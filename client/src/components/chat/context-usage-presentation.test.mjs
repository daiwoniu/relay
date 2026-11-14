import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getContextUsagePresentation, selectContextUsageSnapshot } from './context-usage-presentation.ts';

const chatInputSource = (await Promise.all([
  './ChatInput.tsx',
  './ChatInputMetadataBar.tsx',
  './ContextUsageDetails.tsx',
  './context-usage-presentation.ts',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
const contextUsageDetailsSource = await readFile(new URL('./ContextUsageDetails.tsx', import.meta.url), 'utf8');
const contextUsagePresentationSource = await readFile(new URL('./context-usage-presentation.ts', import.meta.url), 'utf8');
const messageStyles = await readFile(new URL('../../styles/message-ui.css', import.meta.url), 'utf8');

const handoffAction = {
  title: '需要在新会话继续当前任务？',
  description: '整理当前进展，生成可带到新会话的交接摘要。',
  actionLabel: '整理交接信息',
};

const baseUsage = {
  inputTokens: 80000,
  cachedInputTokens: 70000,
  outputTokens: 4000,
  reasoningOutputTokens: 2500,
  totalTokens: 84000,
  modelContextWindow: 200000,
};

test('精确上下文用量生成百分比、剩余量和动态无障碍描述', () => {
  assert.deepEqual(getContextUsagePresentation(baseUsage), {
    contextWindow: 200000,
    percent: 42,
    remainingPercent: 58,
    tone: 'normal',
    scopeLabel: '最近一次模型请求',
    emptyTitle: null,
    emptyDescription: null,
    riskNotice: null,
    handoffAction,
    ariaLabel: '最近一次模型请求的上下文已使用 42%，查看上下文详情',
  });
});

test('上下文风险颜色使用明确阈值', () => {
  const warning = getContextUsagePresentation({ ...baseUsage, totalTokens: 140000 });
  assert.equal(warning.tone, 'warning');
  assert.deepEqual(warning.riskNotice, {
    level: 'warning',
    title: '建议在当前阶段结束后新建会话',
    description: '上下文已使用 70%，继续对话会逐步增加后续请求携带的历史内容。',
  });
  assert.deepEqual(warning.handoffAction, handoffAction);

  const danger = getContextUsagePresentation({ ...baseUsage, totalTokens: 170000 });
  assert.equal(danger.tone, 'danger');
  assert.deepEqual(danger.riskNotice, {
    level: 'danger',
    title: '建议尽快新建会话',
    description: '上下文已使用 85%，长上下文会放大后续工具调用成本。',
  });
  assert.deepEqual(danger.handoffAction, handoffAction);
});

test('窗口上限未知时不生成伪精确百分比', () => {
  assert.deepEqual(getContextUsagePresentation({ ...baseUsage, modelContextWindow: null }), {
    contextWindow: null,
    percent: null,
    remainingPercent: null,
    tone: 'unknown',
    scopeLabel: '最近一次模型请求',
    emptyTitle: null,
    emptyDescription: null,
    riskNotice: null,
    handoffAction,
    ariaLabel: '最近一次模型请求的上下文已使用 84,000 Tokens，模型窗口上限未知，查看上下文详情',
  });
});

test('空闲状态没有引擎用量时显示未知状态', () => {
  assert.deepEqual(getContextUsagePresentation(), {
    contextWindow: null,
    percent: null,
    remainingPercent: null,
    tone: 'unknown',
    scopeLabel: '最近一次模型请求',
    emptyTitle: '暂无引擎精确用量',
    emptyDescription: '收到引擎精确用量后显示上下文占用。',
    riskNotice: null,
    handoffAction,
    ariaLabel: '暂无引擎精确上下文用量，查看上下文详情',
  });
});

test('新回合尚无用量时保留上一轮快照避免圆环闪空', () => {
  assert.deepEqual(selectContextUsageSnapshot(baseUsage, undefined, true), {
    tokenUsage: baseUsage,
    scope: 'recent',
  });
});

test('当前回合有用量时优先使用当前快照，空闲时恢复最近快照', () => {
  const currentUsage = { ...baseUsage, totalTokens: 90000 };
  assert.deepEqual(selectContextUsageSnapshot(baseUsage, currentUsage, true), {
    tokenUsage: currentUsage,
    scope: 'current',
  });
  assert.deepEqual(selectContextUsageSnapshot(baseUsage, undefined, false), {
    tokenUsage: baseUsage,
    scope: 'recent',
  });
});

test('输入区显示圆环并在不占布局宽度的前提下扩大热区', () => {
  assert.match(chatInputSource, /<CircularProgress percent=\{contextUsage\.percent\} tone=\{contextUsage\.tone\} count=\{contextCompactionCount\} \/>/);
  assert.match(messageStyles, /\.composer-context-trigger::after \{ position: absolute; inset: -5px; content: ''; \}/);
  assert.match(chatInputSource, /aria-label=\{contextCompactionCount >= 1/);
  assert.match(chatInputSource, /selectContextUsageSnapshot\(/);
  assert.match(chatInputSource, /上下文占用/);
  assert.doesNotMatch(chatInputSource, />当前上下文</);
  assert.doesNotMatch(chatInputSource, /DEFAULT_CONTEXT_WINDOW|estimateTokens/);
});

test('交接入口不依赖风险阈值，跨端共用并在运行中禁止切换', () => {
  assert.match(chatInputSource, /contextUsage\.handoffAction/);
  assert.match(chatInputSource, /contextUsage\.riskNotice/);
  assert.match(chatInputSource, /需要在新会话继续当前任务/);
  assert.match(chatInputSource, /mobile=\{isMobile\}/);
  assert.match(chatInputSource, /mobile \? 'min-h-9 w-full' : 'min-h-8 w-auto'/);
  assert.match(chatInputSource, /var\(--color-surface\)/);
  assert.doesNotMatch(chatInputSource, /var\(--color-bg-primary\)/);
  assert.match(chatInputSource, /var\(--color-notice-attention-bg\)/);
  assert.match(chatInputSource, /var\(--color-danger-hover\)/);
  assert.match(chatInputSource, /CONTEXT_SESSION_HANDOFF_REQUEST/);
  assert.match(chatInputSource, /findContextSessionHandoffSummary/);
  assert.match(chatInputSource, /buildContextSessionContinuationDraft/);
  assert.match(chatInputSource, /hasContextSessionHandoffDraftConflict/);
  assert.match(chatInputSource, /readChatDraft\(sessionStorage, newSessionDraftKey\)/);
  assert.match(chatInputSource, /readAttachmentDrafts\(sessionStorage, newSessionAttachmentDraftKey\)/);
  assert.match(chatInputSource, /writeChatDraft\(sessionStorage, newSessionDraftKey, continuationDraft\)/);
  assert.match(chatInputSource, /setActiveSession\('', \{ autoOpenProjectPicker: false \}\)/);
  assert.match(chatInputSource, /const contextGovernanceBusy = isStreaming \|\| isQueued \|\| isAwaitingAction \|\| isSubmitting/);
  assert.match(chatInputSource, /input\.trim\(\)\.length > 0 \|\| attachments\.length > 0/);
  assert.match(chatInputSource, /contextSessionHandoffDraftConflict/);
  assert.match(chatInputSource, /actionDisabled=\{contextSessionHandoffSummary[\s\S]*contextSessionHandoffDraftConflict[\s\S]*contextGovernanceActionDisabled\}/);
  assert.match(chatInputSource, /请先处理新会话草稿/);
  assert.doesNotMatch(chatInputSource, /handleContext.*onSend/s);
});

test('自动整理次数在详情与圆环中心按需显示且不进入风险判断', () => {
  assert.match(chatInputSource, /count=\{currentSession\?\.context_compaction_count \?\? 0\}/);
  assert.match(contextUsageDetailsSource, /count > 0/);
  assert.match(contextUsageDetailsSource, /上下文已自动整理 \{count\} 次/);
  assert.match(contextUsageDetailsSource, /较早内容已被摘要，以便继续当前会话。/);
  assert.doesNotMatch(contextUsagePresentationSource, /context_compaction_count|已自动整理/);
  assert.match(chatInputSource, /displayCount >= 1/);
  assert.match(chatInputSource, /displayCount > 9 \? '9\+' : String\(displayCount\)/);
  assert.match(chatInputSource, /\{displayLabel\}/);
  assert.match(chatInputSource, /y=\{size \/ 2 - 0\.5\}/);
  assert.match(chatInputSource, /fontWeight="700"/);
});
