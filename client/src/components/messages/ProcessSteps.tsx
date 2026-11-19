import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo, memo, lazy, Suspense, type ReactNode } from 'react';
import {featureAction} from '../../analytics/features';
import { useSessionFollowupStore } from '../../stores/session-followups';
import type { ProcessStep, ProcessTimelineEntry } from '../../stores/chat';
import { upsertProcessStep } from '../../stores/process-steps';
import InteractionPanel, { type InteractionResponseHandler } from './InteractionPanel';
import AsyncQuestionPanel, { type AsyncQuestionAnswerHandler } from './AsyncQuestionPanel';
import ReadOnlyInteraction from './ReadOnlyInteraction';
import { getEffectiveProcessOperationGroupExpanded, getProcessOperationGroupState } from './process-operation-group';
import { getProcessStepDisclosureState } from './process-step-disclosure';
import { buildProcessTimelineSections, getDefaultExpandedNarrativeItemId, getProcessNarrativeStatus, type ProcessExecutionSection } from './process-timeline';
import { getProcessStepStatus, getProcessStepStatusCounts, isPendingProcessInteraction } from './process-step-status';
import { getCollabAgentStepInfo } from './collab-agent-step';
import { getSubAgentActivityLabel, getSubAgentActivityStepInfo, hasSubAgentReportReference } from './sub-agent-activity';
import SubAgentReport, { type SubAgentReportControl } from './SubAgentReport';
import { getInitialProcessPanelCollapsed, getSearchPreservedExpandedState, shouldAutoCollapseProcessPanel } from './process-panel-state';
import { getToolCallTitle } from './tool-call-title';
import Tooltip from '../ui/Tooltip';
import { shouldShowProcessPanelBottomCollapse } from './process-panel-bottom-collapse';
import { getNextFollowLatestState } from '../chat/message-auto-scroll.ts';
import { getReasoningDisplayText, hasVisibleProcessStep, getProcessText as toText, getProcessCommand as getCommand } from '../../stores/process-step-visibility';
import { formatStoredOutputSummary } from './process-output-summary';
import { getProcessPlan, isStructuredPlan } from './process-plan';
import { describeWebOperation, describeFileChanges } from '../../stores/process-event-summary.ts';
import ProcessPlan from './ProcessPlan';
import StepTypeIcon from './ProcessActionIcon';
import ErrorBoundary from '../ErrorBoundary';
import type { ProcessFlowContext, ProcessView, FlowRuntimeStatus } from './process-flow-model';
import type { MessageOutcome } from '../../generated/relay-contracts';

const EMPTY_FLOW_TIMELINE: ProcessTimelineEntry[] = [];
const ProcessFlow = lazy(() => import('./ProcessFlow'));

interface StepInfo {
  action: string;
  title: string;
  fullTitle?: string;
  command?: string;
  metadata?: string[];
  output?: string;
  expandable?: boolean;
}

type StepDetails = Record<string, any>;

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function formatDuration(durationMs: unknown): string | null {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}秒`;
}

function extractScriptPath(command: string): string | null {
  const matches = command.match(/(?:"[^"]+\.(?:py|mjs|cjs|js|ts|tsx|ps1|sh|bat|cmd)"|[^\s'"]+\.(?:py|mjs|cjs|js|ts|tsx|ps1|sh|bat|cmd))/gi);
  return matches?.[matches.length - 1]?.replace(/^['"]|['"]$/g, '') || null;
}

/** 清理终端颜色、光标等 ANSI 控制序列，避免浏览器显示为乱码 */
function stripTerminalControlCodes(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function summarizeOutput(output: unknown, storedSummary?: unknown): string | undefined {
  const historicalSummary = formatStoredOutputSummary(storedSummary);
  if (historicalSummary) return historicalSummary;
  const text = stripTerminalControlCodes(toText(output)).trim();
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  return `${lines.length} 行输出 · ${truncate(lines[0], 160)}`;
}

/** 从步骤原始数据提取标题和详情 */
function getStepInfo(step: ProcessStep): StepInfo {
  const details = step.details as StepDetails;
  switch (step.type) {
    case 'commandExecution': {
      const command = getCommand(details);
      const commandLine = command.replace(/\s+/g, ' ');
      const metadata = [details.cwd ? `目录：${details.cwd}` : ''].filter(Boolean);
      const scriptPath = extractScriptPath(command);
      const readMatch = commandLine.match(/^(?:rtk\s+read|Get-Content|cat|type)\s+(.+)$/i);
      const searchMatch = commandLine.match(/^(?:rtk\s+grep|rg|Select-String)\s+(.+)$/i);
      const isTest = /(?:^|\s)(?:npm\s+(?:run\s+)?test|pytest|node\s+--test|mvn\b.*\btest|rtk\s+test)(?:\s|$)/i.test(commandLine);
      const isBuild = /(?:npm\s+run\s+build|vite\s+build|\btsc\b|mvn\b.*\bpackage)/i.test(commandLine);

      if (readMatch) {
        return { action: '查看文件', title: truncate(readMatch[1], 180), fullTitle: readMatch[1], command, metadata, output: summarizeOutput(details.aggregatedOutput, details.outputSummary) };
      }
      if (searchMatch) {
        return { action: '搜索内容', title: truncate(searchMatch[1], 180), fullTitle: searchMatch[1], command, metadata, output: summarizeOutput(details.aggregatedOutput, details.outputSummary) };
      }
      if (isTest) {
        return { action: '运行测试', title: scriptPath || truncate(commandLine, 180), fullTitle: scriptPath || commandLine, command, metadata, output: summarizeOutput(details.aggregatedOutput, details.outputSummary) };
      }
      if (isBuild) {
        return { action: '构建项目', title: scriptPath || truncate(commandLine, 180), fullTitle: scriptPath || commandLine, command, metadata, output: summarizeOutput(details.aggregatedOutput, details.outputSummary) };
      }
      if (scriptPath) {
        return { action: '运行脚本', title: scriptPath, command, metadata, output: summarizeOutput(details.aggregatedOutput, details.outputSummary) };
      }
      return { action: '执行命令', title: truncate(commandLine || '命令', 180), fullTitle: commandLine || '命令', command, metadata, output: summarizeOutput(details.aggregatedOutput, details.outputSummary) };
    }
    case 'webSearch': {
      const web = describeWebOperation(details);
      return { action: web.title, title: web.subtitle, metadata: web.hint ? [web.hint] : undefined };
    }
    case 'fileChange': {
      const change = describeFileChanges(details);
      const files = change.paths;
      const action = `${change.action === '变更' ? '编辑' : change.action}文件`;
      return {
        action,
        title: files.length > 0 ? files.join('、') : '文件内容',
        command: toText(details.diff || details.patch || details.summary) || undefined,
        metadata: change.counts ? [change.counts] : undefined,
      };
    }
    case 'reasoning': {
      const text = getReasoningDisplayText(details);
      const fallback = getProcessStepStatus(step) === 'in_progress'
        ? '正在整理执行思路'
        : '内部分析已完成，模型未提供可展示摘要';
      return { action: '分析思考', title: truncate(text || fallback, 180), fullTitle: text || fallback };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const toolName = details.name || details.toolName || details.tool || '';
      const rawInput = details.arguments || details.input || details.params;
      const input = toText(rawInput);
      const patchFiles = input.match(/(?:Update|Add|Delete) File:\s*([^\n]+)/g)?.map((entry) => entry.replace(/^.*File:\s*/, '')) || [];
      const kind = toText(details.kind);
      const isEdit = /apply_patch|edit|write/i.test(`${toolName} ${kind}`) || Boolean(rawInput?.filePath || rawInput?.path);
      const isView = /view_image|read|fetch|get/i.test(toolName);
      const isCommand = /execute|command|bash|shell|terminal/i.test(`${toolName} ${kind}`) || Boolean(rawInput?.command);
      const fullTitle = patchFiles.length > 0
        ? patchFiles.join('、')
        : getToolCallTitle(rawInput, toolName || '工具调用');
      return {
        action: isEdit ? '编辑文件' : isView ? '查看内容' : isCommand ? '执行命令' : '调用工具',
        title: truncate(fullTitle, 180),
        fullTitle,
        command: input || undefined,
        output: summarizeOutput(details.result || details.output, details.outputSummary),
      };
    }
    case 'plan': {
      const planCount = Number(details.planCount) || 0;
      return { action: '更新计划', title: planCount > 0 ? `${planCount} 个步骤` : toText(details.content || details.text) || '制定执行计划' };
    }
    case 'collabAgentToolCall': {
      return getCollabAgentStepInfo(details);
    }
    case 'subAgentActivity': {
      return getSubAgentActivityStepInfo(details);
    }
    case 'imageGeneration': {
      const prompt = details.prompt || details.content || '';
      return { action: '生成图片', title: truncate(prompt || '图片生成', 180), fullTitle: prompt || '图片生成' };
    }
    case 'systemNotice': {
      const noticeType = toText(details.noticeType);
      const action = details.kind === 'engine_retry'
        ? '连接重试'
        : noticeType === 'model_rerouted'
        ? '模型切换'
        : noticeType === 'context_compaction'
          ? '上下文整理'
          : /warning/.test(noticeType)
            ? '安全提示'
            : '系统提示';
      return { action, title: toText(details.title || details.message) || '系统提示', command: toText(details.message) || undefined };
    }
    case 'contextCompaction': {
      const title = getProcessStepStatus(step) === 'in_progress'
        ? '正在整理较早的会话上下文'
        : getProcessStepStatus(step) === 'completed' ? '已整理较早的会话上下文' : '会话上下文整理未完成';
      return { action: '上下文整理', title };
    }
    case 'imageView': return { action: '查看图片', title: toText(details.path || details.filePath) || '查看图片记录' };
    case 'hookPrompt': return { action: 'Hook 提示', title: getReasoningDisplayText(details) || toText(details.name) || '查看提示详情' };
    case 'sleep': return { action: '引擎等待', title: '引擎报告的等待事件' };
    case 'enteredReviewMode': return { action: '进入审查模式', title: getReasoningDisplayText(details) || '查看审查记录' };
    case 'exitedReviewMode': return { action: '退出审查模式', title: getReasoningDisplayText(details) || '查看审查记录' };
    default:
      return { action: '处理步骤', title: step.type || '未知步骤' };
  }
}

/** 状态指示器 */
function StepStatus({ step }: { step: ProcessStep }) {
  const details = step.details as StepDetails;
  const failed = getProcessStepStatusCounts([step]).failedCount > 0;
  if (step.type === 'subAgentActivity' && !failed) return <span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">{getSubAgentActivityLabel(details)}</span>;
  if (getProcessStepStatus(step) === 'in_progress') {
    return (
      <span className="process-step-status process-step-status--running shrink-0 flex items-center gap-1 whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
        <span className="w-3 h-3 rounded-full border-[1.5px] border-current border-t-transparent animate-spin" />
        进行中
      </span>
    );
  }
  if (failed) {
    return (
      <span className="process-step-status process-step-status--failed shrink-0 flex items-center gap-1 whitespace-nowrap text-[11px] text-[var(--color-status-danger)]">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        {details.exitCode != null ? `失败 (${details.exitCode})` : '失败'}
      </span>
    );
  }
  return (
    <span className="process-step-status process-step-status--success shrink-0 flex items-center gap-1 whitespace-nowrap text-[11px] text-emerald-600 dark:text-emerald-400">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      完成
    </span>
  );
}

interface Props {
  readOnly?: boolean;
  flowDetailsPending?: boolean;
  onLoadFlowDetails?: () => void;
  flowRuntimeStatus?: FlowRuntimeStatus;
  flowContext?: ProcessFlowContext;
  flowFinalContent?: string;
  flowFinalRecordedAt?: number;
  flowOutcome?: MessageOutcome;
  steps: ProcessStep[];
  sessionId?: string;
  messageId?: string;
  processContent?: string;
  processContentDetail?: ReactNode;
  processTimeline?: ProcessTimelineEntry[];
  renderNarrativeDetail?: (content: string) => ReactNode;
  defaultCollapsed?: boolean;
  preserveExpandedOnSettle?: boolean;
  settled?: boolean;
  narrativeStatus?: 'in_progress' | 'completed' | 'stopped';
  onInteractionRespond?: InteractionResponseHandler;
  onAsyncQuestionAnswer?: AsyncQuestionAnswerHandler;
  answeredAsyncQuestionIds?: Set<string>;
  asyncQuestionAnswers?: Map<string, string>;
  canAnswerAsyncQuestion?: boolean;
  searchTargetScope?: 'message' | 'process' | 'operation';
  searchTargetItemId?: string;
  full?: boolean;
  historicalRecords?: ReactNode;
  historicalRecordCount?: number;
}

function ProcessNarrativeRow({ content, detail, status, defaultExpanded, itemId, searchTarget, full }: { content: string; detail?: ReactNode; status: 'in_progress' | 'completed' | 'stopped'; defaultExpanded: boolean; itemId?: string; searchTarget?: boolean; full?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const wasSearchTargetRef = useRef(Boolean(searchTarget));
  const effectiveExpanded = full || Boolean(searchTarget) || expanded;
  const narrativeScrollRef = useRef<HTMLDivElement>(null);
  const narrativeContentRef = useRef<HTMLDivElement>(null);
  const narrativeScrollFrameRef = useRef<number | null>(null);
  const narrativePreviousScrollTopRef = useRef(0);
  const narrativeFollowLatestRef = useRef(true);
  const summary = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*+#>]+\s*/, '').trim())
    .find(Boolean) || '处理过程回复';

  useLayoutEffect(() => {
    const wasSearchTarget = wasSearchTargetRef.current;
    const isSearchTarget = Boolean(searchTarget);
    wasSearchTargetRef.current = isSearchTarget;
    setExpanded((currentExpanded) => getSearchPreservedExpandedState(
      currentExpanded,
      defaultExpanded,
      wasSearchTarget,
      isSearchTarget,
    ));
    if (defaultExpanded && status === 'in_progress') narrativeFollowLatestRef.current = true;
  }, [defaultExpanded, searchTarget, status]);

  const scheduleNarrativeScrollToBottom = useCallback(() => {
    if (
      status !== 'in_progress' || !effectiveExpanded
      || !narrativeFollowLatestRef.current
      || narrativeScrollFrameRef.current !== null
    ) return;

    narrativeScrollFrameRef.current = requestAnimationFrame(() => {
      narrativeScrollFrameRef.current = null;
      const container = narrativeScrollRef.current;
      if (!container || status !== 'in_progress' || !narrativeFollowLatestRef.current) return;
      container.scrollTop = container.scrollHeight;
      narrativePreviousScrollTopRef.current = container.scrollTop;
    });
  }, [effectiveExpanded, status]);

  useEffect(() => () => {
    if (narrativeScrollFrameRef.current !== null) {
      cancelAnimationFrame(narrativeScrollFrameRef.current);
      narrativeScrollFrameRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    scheduleNarrativeScrollToBottom();
  }, [content, detail, effectiveExpanded, status, scheduleNarrativeScrollToBottom]);

  useEffect(() => {
    const content = narrativeContentRef.current;
    if (status !== 'in_progress' || !effectiveExpanded || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => scheduleNarrativeScrollToBottom());
    observer.observe(content);
    return () => observer.disconnect();
  }, [effectiveExpanded, status, scheduleNarrativeScrollToBottom]);

  const handleNarrativeScroll = () => {
    const container = narrativeScrollRef.current;
    if (!container || status !== 'in_progress') return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    narrativeFollowLatestRef.current = getNextFollowLatestState({
      followingLatest: narrativeFollowLatestRef.current,
      previousScrollTop: narrativePreviousScrollTopRef.current,
      scrollTop: container.scrollTop,
      distanceToBottom,
    });
    narrativePreviousScrollTopRef.current = container.scrollTop;
  };

  const toggleExpanded = () => {featureAction('message',expanded?'close':'expand_process','message');
    setExpanded((value) => {
      const nextExpanded = !value;
      if (nextExpanded && status === 'in_progress') narrativeFollowLatestRef.current = true;
      return nextExpanded;
    });
  };
  const narrativeToneClass = status === 'in_progress'
    ? 'border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)]'
    : status === 'stopped'
      ? 'border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)]'
      : 'border-[var(--color-border-light)] bg-transparent';

  return (
    <section
      data-process-narrative
      data-search-target={searchTarget ? `process:${itemId || ''}` : undefined}
      className={`process-narrative process-narrative--${status} overflow-hidden rounded-lg border text-xs text-[var(--color-text-secondary)] ${narrativeToneClass}`}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={effectiveExpanded}
        className="process-narrative__main flex w-full min-w-0 cursor-pointer items-center text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)]"
      >
        <div className="flex-1 min-w-0 flex items-center justify-between gap-3 overflow-hidden">
          <div className="flex flex-1 min-w-0 items-center gap-2 overflow-hidden">
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" className={`shrink-0 transition-transform ${effectiveExpanded ? '' : '-rotate-90'}`}>
              <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="shrink-0 flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 bg-[var(--color-bg-tertiary)] text-[10px] font-medium text-[var(--color-text-secondary)]">
              <StepTypeIcon action="过程回复" />
              过程回复
            </span>
            <Tooltip overflowOnly content={summary} className="min-w-0 flex-1">
              <span className="min-w-0 flex-1 truncate whitespace-nowrap font-semibold text-[var(--color-text)]">{summary}</span>
            </Tooltip>
          </div>
          <span className="shrink-0 flex items-center gap-1 whitespace-nowrap text-[11px]" style={{ color: status === 'in_progress' ? 'var(--color-status-processing)' : status === 'stopped' ? 'var(--color-status-stopped)' : 'var(--color-status-success)' }}>
            {status === 'in_progress' ? (
              <span className="w-3 h-3 rounded-full border border-current border-t-transparent animate-spin" />
            ) : status === 'completed' ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <span className="w-2 h-2 rounded-sm bg-current" />
            )}
            {status === 'in_progress' ? '进行中' : status === 'stopped' ? '已停止' : '完成'}
          </span>
        </div>
      </button>

      {effectiveExpanded && (
        <div
          data-process-narrative-content
          ref={narrativeScrollRef}
          onScroll={handleNarrativeScroll}
          className="process-narrative__details markdown-body max-h-64 overflow-y-auto border-t border-[var(--color-border-light)] bg-transparent text-sm text-[var(--color-text)]"
        >
          <div ref={narrativeContentRef} data-search-content={searchTarget ? true : undefined}>
            {status === 'in_progress'
              ? <div className="whitespace-pre-wrap break-words">{content}</div>
              : detail || <div className="whitespace-pre-wrap break-words">{content}</div>}
          </div>
        </div>
      )}
    </section>
  );
}

function ProcessOperationGroup({ steps, searchTargetItemId, full }: { steps: ProcessStep[]; searchTargetItemId?: string; full?: boolean }) {
  const state = getProcessOperationGroupState(steps);
  const [expanded, setExpanded] = useState(false);
  const containsSearchTarget = Boolean(searchTargetItemId && steps.some((step) => step.id === searchTargetItemId));
  const effectiveExpanded = full || getEffectiveProcessOperationGroupExpanded(expanded, containsSearchTarget);

  useLayoutEffect(() => {
    if (containsSearchTarget) setExpanded(true);
  }, [containsSearchTarget]);

  return (
    <section className={`process-group process-group--${state.tone} overflow-hidden rounded-lg border border-[var(--color-border-light)] bg-transparent`}>
      <button
        type="button"
        onClick={() => {featureAction('message',expanded?'close':'expand_details','message');setExpanded((value) => !value);}}
        aria-expanded={effectiveExpanded}
        className="process-group__main flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" className={`shrink-0 transition-transform ${effectiveExpanded ? '' : '-rotate-90'}`} aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)]">{state.label}</span>
        {state.tone === 'processing' ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-status-processing)]">
            <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            {state.progressLabel}
          </span>
        ) : state.tone === 'danger' ? (
          <span className="shrink-0 text-[11px] text-[var(--color-status-danger)]">{state.progressLabel}</span>
        ) : (
          <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">{state.progressLabel}</span>
        )}
      </button>
      {effectiveExpanded && (
        <div className="process-group__items border-t border-[var(--color-border-light)] divide-y divide-[var(--color-border-light)]">
          {steps.map((step) => <ProcessStepRow key={step.id} step={step} searchTarget={step.id === searchTargetItemId} full={full} />)}
        </div>
      )}
    </section>
  );
}

function ProcessSubtaskBlock({ step, searchTarget = false, full, report }: { step: ProcessStep; searchTarget?: boolean; full?: boolean; report?: ReactNode }) {
  if (step.type === 'subAgentActivity') return <div className="px-2">{report || <ProcessStepRow step={step} searchTarget={searchTarget} full={full} />}</div>;
  return (
    <section className={`process-group process-group--subtask process-group--${getProcessStepStatus(step) === 'in_progress' ? 'processing' : getProcessStepStatusCounts([step]).failedCount > 0 ? 'danger' : 'success'} overflow-hidden rounded-lg border border-[var(--color-border-light)] bg-transparent`}>
      <ProcessStepRow step={step} searchTarget={searchTarget} full={full} />
    </section>
  );
}

function ProcessExecutionGroup({ sections, sessionId, onInteractionRespond, onAsyncQuestionAnswer, answeredAsyncQuestionIds, asyncQuestionAnswers, canAnswerAsyncQuestion, searchTargetItemId, full, readOnly, renderSubtaskReport }: {
  renderSubtaskReport?: (step: ProcessStep) => ReactNode;
  readOnly?: boolean;
  sections: ProcessExecutionSection[];
  sessionId?: string;
  onInteractionRespond?: InteractionResponseHandler;
  onAsyncQuestionAnswer?: AsyncQuestionAnswerHandler;
  answeredAsyncQuestionIds?: Set<string>;
  asyncQuestionAnswers?: Map<string, string>;
  canAnswerAsyncQuestion?: boolean;
  searchTargetItemId?: string;
  full?: boolean;
}) {
  return (
    <div data-process-execution-group>
      {sections.map((section) => {
        if (section.type === 'interaction') {
          if (readOnly) return <ReadOnlyInteraction key={section.key} step={section.step} />;
          const searchTarget = section.step.id === searchTargetItemId;
          if (section.step.details?.interactionKind === 'async_question') return <div key={section.key} className="process-timeline__interaction" data-search-target={searchTarget ? `operation:${section.step.id}` : undefined}><AsyncQuestionPanel step={section.step} sessionId={sessionId || ''} answered={answeredAsyncQuestionIds?.has(section.step.id) || false} answerContent={asyncQuestionAnswers?.get(section.step.id)} canAnswer={Boolean(canAnswerAsyncQuestion)} onAnswer={onAsyncQuestionAnswer} onRespond={onInteractionRespond} full={full} /></div>;
          return <div key={section.key} className="process-timeline__interaction" data-search-target={searchTarget ? `operation:${section.step.id}` : undefined} data-search-content={searchTarget ? true : undefined}><InteractionPanel step={section.step} onRespond={onInteractionRespond} full={full} /></div>;
        }
        if (section.type === 'subtask') {
          return <ProcessSubtaskBlock key={section.key} step={section.step} searchTarget={section.step.id === searchTargetItemId} full={full} report={renderSubtaskReport?.(section.step)} />;
        }
        return <ProcessOperationGroup key={section.key} steps={section.steps} searchTargetItemId={searchTargetItemId} full={full} />;
      })}
    </div>
  );
}

function ProcessStepRow({ step, searchTarget = false, full, hideTiming = false, contentOnly = false, hideFileList = false, reportControl }: { step: ProcessStep; searchTarget?: boolean; full?: boolean; hideTiming?: boolean; contentOnly?: boolean; hideFileList?: boolean; reportControl?: SubAgentReportControl }) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const info = getStepInfo(step);
  const details = step.details as StepDetails;
  const duration = hideTiming ? null : formatDuration(details.durationMs ?? details.duration);
  const fileList = contentOnly && step.type === 'fileChange' ? describeFileChanges(details).paths : [];
  const fileReport = step.type === 'dynamicToolCall' && details.tool === 'relay_report_file_changes';
  const disclosure = getProcessStepDisclosureState(info);
  const stepTone = getProcessStepStatus(step) === 'in_progress'
    ? 'running'
    : getProcessStepStatusCounts([step]).failedCount > 0
      ? 'failed'
      : step.type === 'subAgentActivity' ? 'notice' : 'success';
  const canExpand = disclosure.canExpand || Boolean(reportControl);
  const effectiveDetailsExpanded = reportControl?.expanded ?? (full || (searchTarget && disclosure.canExpand) || detailsExpanded);
  useEffect(() => {
    if (searchTarget && disclosure.canExpand) setDetailsExpanded(true);
  }, [disclosure.canExpand, searchTarget]);

  const showFileList = !hideFileList && fileList.length > 0;
  const showDescription = !(hideFileList && (['fileChange', 'imageView'].includes(step.type) || fileReport))
    && step.type !== 'subAgentActivity' && (!contentOnly || !fileList.length && !info.command && !info.output && !info.metadata?.length);
  const showCommand = Boolean(info.command) && !(hideFileList && fileReport);
  const showMetadata = Boolean(info.metadata?.length);
  if (contentOnly && (!disclosure.canExpand || !effectiveDetailsExpanded
    || !(showFileList || showDescription || showCommand || showMetadata || info.output))) return null;

  return (
    <div
      data-search-target={searchTarget ? `operation:${step.id}` : undefined}
      data-search-content={searchTarget ? true : undefined}
      className={`process-step process-step--${stepTone} text-xs text-[var(--color-text-secondary)]`}
    >
      {!contentOnly && <button
        type="button"
        onClick={() => {if(canExpand)featureAction('message',reportControl?'expand_report':'expand_details','message');return reportControl ? reportControl.onToggle() : disclosure.canExpand && setDetailsExpanded((value) => !value);}}
        disabled={!canExpand}
        aria-expanded={canExpand ? effectiveDetailsExpanded : undefined}
        className={`process-step__main w-full min-w-0 flex items-center text-left ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className="flex-1 min-w-0 flex items-center justify-between gap-3 overflow-hidden">
          <div className="flex flex-1 min-w-0 items-center gap-2 overflow-hidden">
            {canExpand && (
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" className={`shrink-0 transition-transform ${effectiveDetailsExpanded ? '' : '-rotate-90'}`}>
                <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            <span className="shrink-0 flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 bg-[var(--color-bg-tertiary)] text-[10px] font-medium text-[var(--color-text-secondary)]">
              <StepTypeIcon action={info.action} />
              {info.action}
            </span>
            <Tooltip overflowOnly content={info.title} className="min-w-0 flex-1">
              <span className="process-step__summary min-w-0 flex-1 truncate whitespace-nowrap font-medium text-[var(--color-text)]">{info.title}</span>
            </Tooltip>
          </div>
          <div className="shrink-0 flex items-center gap-2 whitespace-nowrap">
            {duration && <span className="whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">{duration}</span>}
            {reportControl?.loading ? <span className="text-[11px] text-[var(--color-text-tertiary)]">正在读取…</span> : <StepStatus step={step} />}
          </div>
        </div>
      </button>}

      {disclosure.canExpand && effectiveDetailsExpanded && (
        <div className="process-step__details space-y-0.5">
          {showFileList && <ul className="flow-file-list">{fileList.map(path => <li key={path}>{path}</li>)}</ul>}
          {showDescription && <div className="process-step__description rounded-md border border-[var(--color-border-light)] bg-[var(--color-surface)] text-[11px] leading-5 whitespace-pre-wrap break-words text-[var(--color-text)]">
            {disclosure.fullTitle}
          </div>}
          {showCommand && (
            <div className="process-step__code rounded-md border border-[var(--color-border-light)] bg-[var(--color-surface)] font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-[var(--color-code-text)] max-h-40 overflow-y-auto">
              {info.command}
            </div>
          )}
          {info.metadata && info.metadata.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
              {info.metadata.map((item) => <span key={item} className="break-all">{item}</span>)}
            </div>
          )}
          {info.output && (
            <div className="process-step__output max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--color-text-tertiary)]">{info.output}</div>
          )}
        </div>
      )}
    </div>
  );
}

function FlowRawRecord({ step }: { step: ProcessStep }) {
  const [open, setOpen] = useState(false);
  return <details className="flow-raw" onToggle={event => {if(event.currentTarget.open!==open)featureAction('message',event.currentTarget.open?'expand_details':'close','message');setOpen(event.currentTarget.open);}}><summary>原始记录</summary>{open && <pre>{JSON.stringify(step, null, 2)}</pre>}</details>;
}

function ProcessStepsComponent({ steps, sessionId, messageId, processContent, processContentDetail, processTimeline, renderNarrativeDetail, defaultCollapsed = true, preserveExpandedOnSettle = false, settled = true, narrativeStatus = 'completed', onInteractionRespond, onAsyncQuestionAnswer, answeredAsyncQuestionIds, asyncQuestionAnswers, canAnswerAsyncQuestion, searchTargetScope, searchTargetItemId, full, historicalRecords, historicalRecordCount = 0, flowContext, flowFinalContent, flowFinalRecordedAt, flowOutcome, flowRuntimeStatus, flowDetailsPending, onLoadFlowDetails, readOnly = false }: Props) {
  const reportAvailable = Boolean(sessionId && messageId && !readOnly);
  const flowDisplayContext = useMemo(() => flowContext ? { ...flowContext, canReadSubAgentReports: reportAvailable } : undefined, [flowContext, reportAvailable]);
  const followups = useSessionFollowupStore(state => sessionId ? state.bySession[sessionId] : undefined);
  const [collapsed, setCollapsed] = useState(() => getInitialProcessPanelCollapsed(defaultCollapsed, settled, preserveExpandedOnSettle, flowContext?.ui));
  const [view, setView] = useState<ProcessView>(flowContext?.ui.view || 'list');
  const [flowToolbarTarget, setFlowToolbarTarget] = useState<HTMLDivElement | null>(null);
  const hasSearchTarget = searchTargetScope === 'process' || searchTargetScope === 'operation';
  const effectiveCollapsed = full ? false : hasSearchTarget ? false : collapsed;
  const [showBottomCollapse, setShowBottomCollapse] = useState(false);
  const wasSettledRef = useRef(flowContext?.ui.panelSettled ?? settled);
  const headerButtonRef = useRef<HTMLButtonElement>(null);
  const processContentRef = useRef<HTMLDivElement>(null);
  const pendingInteractionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shouldAutoCollapseProcessPanel(wasSettledRef.current, settled) && !preserveExpandedOnSettle) {
      setCollapsed(true);
    } else if (preserveExpandedOnSettle) {
      setCollapsed(false);
    }
    wasSettledRef.current = settled;
    if (flowContext) flowContext.ui.panelSettled = settled;
  }, [preserveExpandedOnSettle, settled, flowContext]);

  useEffect(() => { if (flowContext) flowContext.ui.panelExpanded = !collapsed; }, [flowContext, collapsed]);

  useEffect(() => {
    if (searchTargetScope === 'process' || searchTargetScope === 'operation') setCollapsed(false);
  }, [searchTargetItemId, searchTargetScope]);

  useEffect(() => {
    if (effectiveCollapsed) {
      setShowBottomCollapse(false);
      return;
    }
    const content = processContentRef.current;
    if (!content) return;

    const measureContentHeight = () => {
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      setShowBottomCollapse(shouldShowProcessPanelBottomCollapse(
        content.getBoundingClientRect().height,
        viewportHeight,
      ));
    };

    measureContentHeight();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measureContentHeight);
    observer?.observe(content);
    window.addEventListener('resize', measureContentHeight);
    window.visualViewport?.addEventListener('resize', measureContentHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureContentHeight);
      window.visualViewport?.removeEventListener('resize', measureContentHeight);
    };
  }, [effectiveCollapsed]);

  const collapseFromBottom = () => {
    setCollapsed(true);
    requestAnimationFrame(() => headerButtonRef.current?.focus({ preventScroll: true }));
  };

  // 过滤并按 item ID 合并，兼容历史消息或旧后端已经保存的重复步骤。
  const allVisibleSteps = useMemo(() => steps.reduce<ProcessStep[]>((result, step) => {
    if (!hasVisibleProcessStep(step)) return result;
    return upsertProcessStep(result, [], step).processSteps;
  }, []), [steps]);

  const plan = getProcessPlan(allVisibleSteps);
  const flowSteps = useMemo(() => steps.filter(step => step.type !== 'reasoning' || hasVisibleProcessStep(step)), [steps]);
  // Keep active forms mounted at one stable location across all three views.
  const pendingFlowInteractions = flowContext && !readOnly ? allVisibleSteps.filter(step => isPendingProcessInteraction(step, answeredAsyncQuestionIds?.has(step.id))) : [];
  // A submitted answer may be steering/queued before it becomes a saved user message.
  // Keep its delivery card mounted, but stop asking the user to answer it again.
  const actionableFlowInteractions = pendingFlowInteractions.filter(step =>
    (!settled || step.details.interactionKind === 'async_question')
    && !(step.details.interactionKind === 'async_question' && followups?.some(item =>
      item.replyToAsyncQuestionId === step.id && item.state !== 'cancelled')));
  const pendingKey = actionableFlowInteractions.map(step => step.id).join('|');
  useEffect(() => { if (pendingKey && !settled) setCollapsed(false); }, [pendingKey, settled]);
  const openPendingInteraction = () => {
    setCollapsed(false);
    requestAnimationFrame(() => {
      pendingInteractionRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
      const target = pendingInteractionRef.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') || pendingInteractionRef.current?.querySelector<HTMLElement>('button:not(:disabled)');
      target?.focus({ preventScroll: true });
    });
  };
  const pendingFlowIds = new Set(pendingFlowInteractions.map(step => step.id));
  const visibleSteps = allVisibleSteps.filter((step) => !isStructuredPlan(step) && !pendingFlowIds.has(step.id));
  const normalizedProcessContent = processContent?.trim() || '';

  const timelineSections = processTimeline?.length
    ? buildProcessTimelineSections(processTimeline, visibleSteps)
    : null;
  const fallbackExecutionSection = !timelineSections && visibleSteps.length > 0
    ? buildProcessTimelineSections(
      visibleSteps.map((step) => ({ type: 'operation' as const, itemId: step.id })),
      visibleSteps,
    ).find((section) => section.type === 'execution')
    : null;
  // Thought（CodeBuddy 的 agent_thought_chunk）属于处理详情，但流式期间默认折叠，
  // 避免思考中的答案草稿直接占据可见区域；用户仍可展开处理过程查看。
  const defaultExpandedNarrativeItemId = processTimeline && settled
    ? getDefaultExpandedNarrativeItemId(processTimeline, settled)
    : null;
  const narrativeCount = timelineSections
    ? timelineSections.filter((section) => section.type === 'narrative').length
    : normalizedProcessContent ? 1 : 0;

  const renderSubtaskReport = (step: ProcessStep, inline = false) => reportAvailable && hasSubAgentReportReference(step)
    ? <SubAgentReport sessionId={sessionId!} messageId={messageId!} itemId={step.id} renderContent={renderNarrativeDetail} autoLoad={inline}
      renderTrigger={inline ? undefined : control => <ProcessStepRow step={step} searchTarget={searchTargetScope === 'operation' && searchTargetItemId === step.id} full={full} reportControl={control} />} /> : null;
  const ordinaryContent = <>
            {timelineSections ? timelineSections.map((section) => {
              if (section.type === 'narrative') {
                const status = getProcessNarrativeStatus(processTimeline || EMPTY_FLOW_TIMELINE, section.itemId, settled, narrativeStatus);
                return <ProcessNarrativeRow key={section.key} content={section.content} detail={status === 'completed' ? renderNarrativeDetail?.(section.content) : undefined} status={status} defaultExpanded={section.itemId === defaultExpandedNarrativeItemId} itemId={section.itemId} searchTarget={searchTargetScope === 'process' && section.itemId === searchTargetItemId} full={full} />;
              }
              return <ProcessExecutionGroup key={section.key} sections={section.sections} sessionId={sessionId} onInteractionRespond={onInteractionRespond} onAsyncQuestionAnswer={onAsyncQuestionAnswer} answeredAsyncQuestionIds={answeredAsyncQuestionIds} asyncQuestionAnswers={asyncQuestionAnswers} canAnswerAsyncQuestion={canAnswerAsyncQuestion} searchTargetItemId={searchTargetScope === 'operation' ? searchTargetItemId : undefined} full={full} readOnly={readOnly} renderSubtaskReport={renderSubtaskReport} />;
            }) : <>
              {normalizedProcessContent && <ProcessNarrativeRow content={normalizedProcessContent} detail={processContentDetail} status={narrativeStatus} defaultExpanded={settled} searchTarget={searchTargetScope === 'process'} full={full} />}
              {fallbackExecutionSection && <ProcessExecutionGroup sections={fallbackExecutionSection.sections} sessionId={sessionId} onInteractionRespond={onInteractionRespond} onAsyncQuestionAnswer={onAsyncQuestionAnswer} answeredAsyncQuestionIds={answeredAsyncQuestionIds} asyncQuestionAnswers={asyncQuestionAnswers} canAnswerAsyncQuestion={canAnswerAsyncQuestion} searchTargetItemId={searchTargetScope === 'operation' ? searchTargetItemId : undefined} full={full} readOnly={readOnly} renderSubtaskReport={renderSubtaskReport} />}
            </>}
            {historicalRecords}
  </>;
  const renderFlowDetail = (step: ProcessStep, hasFilePreview = false) => {
    if (readOnly && step.type === 'interaction') return <ReadOnlyInteraction step={step} />;
    if (step.type === 'userMessage' || step.type === 'agentMessage') return <FlowRawRecord step={step} />;
    if (isPendingProcessInteraction(step, answeredAsyncQuestionIds?.has(step.id)) && step.details.interactionKind === 'async_question') return <p className="text-xs text-[var(--color-text-secondary)]">此问题尚未关联到回答，请使用流程上方的提问卡片查看或补充回答。</p>;
    if (settled && step.type !== 'plan' && getProcessStepStatus(step) === 'in_progress' && !step.details.resolvedAction && !answeredAsyncQuestionIds?.has(step.id)) return <><p className="text-xs text-[var(--color-text-secondary)]">本次执行已结束，此步骤结果未确认。</p><FlowRawRecord step={step} /></>;
    if (isPendingProcessInteraction(step, answeredAsyncQuestionIds?.has(step.id))) return <p className="text-xs text-[var(--color-text-secondary)]">此请求正在等待处理，请使用流程上方的提问或授权面板。</p>;
    if (step.type === 'interaction') return step.details.interactionKind === 'async_question'
      ? <AsyncQuestionPanel step={step} sessionId={sessionId || ''} answered={answeredAsyncQuestionIds?.has(step.id) || false} answerContent={asyncQuestionAnswers?.get(step.id)} canAnswer={Boolean(canAnswerAsyncQuestion)} onAnswer={onAsyncQuestionAnswer} onRespond={onInteractionRespond} full />
      : <InteractionPanel step={step} onRespond={onInteractionRespond} full />;
    const stepPlan = isStructuredPlan(step) ? getProcessPlan([step]) : null;
    return <>{stepPlan ? <ProcessPlan plan={stepPlan} running={!settled} /> : <ProcessStepRow step={step} full hideFileList={hasFilePreview} hideTiming={view === 'category'} contentOnly={hasFilePreview || view === 'category' || step.type === 'subAgentActivity'} />}
      {renderSubtaskReport(step, true)}<FlowRawRecord step={step} />
    </>;
  };

  if (visibleSteps.length === 0 && !normalizedProcessContent && narrativeCount === 0 && !plan && !historicalRecords && !flowContext) return null;

  return (
    <div className="process-timeline mb-3">
      <button
        ref={headerButtonRef}
        type="button"
        onClick={() => {featureAction('message',collapsed?'expand_process':'close','message');setCollapsed(!collapsed);}}
        aria-expanded={!effectiveCollapsed}
        className="process-timeline__trigger flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
          <svg
            width="10" height="10" viewBox="0 0 12 12" fill="none"
            className={`transition-transform ${effectiveCollapsed ? '-rotate-90' : ''}`}
          >
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
        处理过程{visibleSteps.length + narrativeCount + historicalRecordCount > 0 && ` (${visibleSteps.length + narrativeCount + historicalRecordCount}项)`}
        {plan && <span className="process-plan__summary">· 计划 {plan.completed}/{plan.entries.length}</span>}
      </button>
      {Boolean(pendingKey) && <button type="button" className="process-attention" onClick={openPendingInteraction}>
        <span className="process-attention__label">需要你处理 · {actionableFlowInteractions.length} 项回答或授权</span><span>查看并处理 →</span>
      </button>}
      {!effectiveCollapsed && (
        <div className="process-timeline__panel rounded-lg border border-[var(--color-border)]">
          <div ref={processContentRef} className="process-timeline__content">
            {flowContext && !full && <div className="process-view-toolbar"><div className="process-view-switch" role="group" aria-label="处理过程展示方式">
              {(['list', 'time', 'category'] as const).map(mode => <button key={mode} type="button" aria-pressed={(hasSearchTarget ? 'list' : view) === mode} onClick={() => {
                flowContext.ui.view = mode; setView(mode); if (mode !== 'list' && flowDetailsPending) onLoadFlowDetails?.();
              }}>{({ list: '普通列表', time: '时间流', category: '分类流' })[mode]}</button>)}
            </div><div className="process-view-toolbar__extras" ref={setFlowToolbarTarget} /></div>}
            {pendingFlowInteractions.map(step => <div key={step.id} ref={step.id === actionableFlowInteractions[0]?.id ? pendingInteractionRef : undefined} className={!settled ? 'process-pending-card' : undefined} data-search-target={searchTargetItemId === step.id ? `operation:${step.id}` : undefined}>
              {step.details.interactionKind === 'async_question'
                ? <AsyncQuestionPanel step={step} sessionId={sessionId || ''} answered={false} answerContent={asyncQuestionAnswers?.get(step.id)} canAnswer={Boolean(canAnswerAsyncQuestion)} onAnswer={onAsyncQuestionAnswer} onRespond={onInteractionRespond} full />
                : settled ? <div className="flow-node__detail"><p className="text-xs text-[var(--color-text-secondary)]">本次执行已结束，此请求未确认完成。</p><FlowRawRecord step={step} /></div>
                : <InteractionPanel step={step} onRespond={onInteractionRespond} full />}
            </div>)}
            {flowContext && view !== 'list' && !hasSearchTarget && !full ? <ErrorBoundary fallback={<><p className="text-xs text-[var(--color-text-secondary)]">流程图暂不可用，已回退普通记录。</p>{ordinaryContent}</>}>
              {flowDetailsPending ? <p className="process-flow__settled-note" role="status">处理详情尚未加载，请使用下方“加载详情”查看完整流程。</p> : <Suspense fallback={ordinaryContent}><ProcessFlow toolbarTarget={flowToolbarTarget} context={flowDisplayContext!} steps={flowSteps} timeline={processTimeline || EMPTY_FLOW_TIMELINE} mode={view} streaming={!settled} narrativeStatus={narrativeStatus} outcome={flowOutcome} finalContent={flowFinalContent} finalRecordedAt={flowFinalRecordedAt} answeredIds={answeredAsyncQuestionIds} renderDetail={renderFlowDetail} runtimeStatus={flowRuntimeStatus} /></Suspense>}
            </ErrorBoundary> : ordinaryContent}
            {flowContext && view !== 'list' && !hasSearchTarget && !full && historicalRecords}
          </div>
          {plan && <div className={flowContext ? 'process-plan-dock' : undefined}><ProcessPlan plan={plan} running={!settled && narrativeStatus === 'in_progress'} searchTarget={searchTargetScope === 'operation' && searchTargetItemId === plan.id} /></div>}
          {showBottomCollapse && !hasSearchTarget && (
            <button
              type="button"
              onClick={collapseFromBottom}
              className="process-timeline__collapse flex min-h-[34px] items-center justify-center gap-1.5 border-t border-[var(--color-border)] text-xs text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)] sm:min-h-[30px]"
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="rotate-180" aria-hidden="true">
                <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              收起处理过程
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ProcessStepsComponent);
