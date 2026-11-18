import { Children, Fragment, useState, useCallback, useRef, useEffect, memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import type { ProcessStep, StreamingBlock } from '../../stores/chat';
import { copyToClipboard } from '../../utils/clipboard';
import { shouldDimShareMessage } from '../sharing/share-selection';
import ProcessSteps from './ProcessSteps';
import { hasPendingInteraction } from './process-panel-state';
import CopyIcon from '../icons/CopyIcon';
import { MenuIcon } from '../icons/MenuIcon';
import type { ChangedFileDto, ExecutionStage, MessageModelInfoDto, MessageOutcome, ProcessTimelineEntryDto, TokenUsageDto } from '../../generated/relay-contracts';
import { getMessageStatusPresentation, shouldExpandProcessWithoutFinalReply, type MessageVisualState } from './message-status';
import ExecutionStatusIcon from '../ui/ExecutionStatusIcon';
import { getMessageErrorGuidance } from './message-error-guidance';
import { isMessageSafeToRetry } from './message-retry-safety';
import Tooltip from '../ui/Tooltip';
import type { InteractionResponseHandler } from './InteractionPanel';
import type { AsyncQuestionAnswerHandler } from './AsyncQuestionPanel';
import ChangedFilesSummary from './ChangedFilesSummary';
import ChangedFilesIncompleteNotice from './ChangedFilesIncompleteNotice';
import { useFilePreview } from './useFilePreview';
import { shouldRenderMarkdownImageAsFileLink } from './markdown-image-source';
import FileTypeIcon from './FileTypeIcon';
import BlankProcessingStatus from './BlankProcessingStatus';
import TokenUsageSummary from './TokenUsageSummary';
import DeferredMarkdownContent from './DeferredMarkdownContent';
import { extractMarkdownCodeText } from './markdown-code-text';
import remarkHtmlBreak from './markdown-html-break';
import remarkRelaxedStrong from './remark-relaxed-strong';
import CodexFileReference from './CodexFileReference';
import {
  decodeCodexFileReference,
  remarkCodexFileDirectives,
} from './codex-file-directives';
import {
  getRunningDurationPresentation,
  getSettledDurationPresentation,
} from './message-duration-presentation';
import type { WaitingStage } from '../../utils/waiting-status';
import { hasVisibleProcessPresentation } from '../../stores/process-step-visibility';
import { getRenderedMessageCopyText } from './message-copy-text';
import MessageModelInfo from './MessageModelInfo';
import MessageActionsMenu, { type MessageActionItem } from './MessageActionsMenu';
import { hasExpandedSelectionWithin } from './markdown-selection';
import type { ProcessFlowContext } from './process-flow-model';

interface Props {
  flowContext?: ProcessFlowContext;
  historicalRecords?: ReactNode;
  historicalRecordCount?: number;
  sessionId?: string;
  content: string;
  isStreaming?: boolean;
  isStopping?: boolean;
  isAwaitingAction?: boolean;
  pendingActionKind?: 'approval' | 'input' | 'mixed' | null;
  isRecovering?: boolean;
  duration?: number | null;
  startTime?: number | null;
  createdAt?: number; // 消息创建时间戳（ms），用于计算完成时间
  items?: ProcessStep[];
  processContent?: string;
  processTimeline?: ProcessTimelineEntryDto[];
  changedFiles?: ChangedFileDto[];
  changedFilesIncomplete?: boolean;
  hasDetails?: boolean;
  detailsLoaded?: boolean;
  processItemCount?: number;
  asyncQuestionIds?: string[];
  processNarrativeCount?: number;
  changedFileCount?: number;
  onLoadDetails?: () => Promise<void>;
  deferMarkdown?: boolean;
  optimizeContentVisibility?: boolean;
  projectPath?: string;
  mobile?: boolean;
  streamingSteps?: ProcessStep[];
  streamingBlocks?: StreamingBlock[];
  stopped?: boolean; // 是否被手动停止
  outcome?: MessageOutcome;
  executionStage?: ExecutionStage;
  waitingStage?: WaitingStage;
  errorCode?: string;
  errorMessage?: string;
  tokenUsage?: TokenUsageDto;
  modelInfo?: MessageModelInfoDto;
  onInteractionRespond?: InteractionResponseHandler;
  onAsyncQuestionAnswer?: AsyncQuestionAnswerHandler;
  answeredAsyncQuestionIds?: Set<string>;
  asyncQuestionAnswers?: Map<string, string>;
  canAnswerAsyncQuestion?: boolean;
  readOnly?: boolean;
  full?: boolean;
  onShare?: () => void;
  onSelectMessagesShare?: () => void;
  onFork?: () => void;
  forkPending?: boolean;
  selectionMode?: boolean;
  selected?: boolean;
  selectable?: boolean;
  onToggleSelection?: () => void;
  messageId?: string;
  searchTarget?: boolean;
  onResync?: () => void;
  searchTargetScope?: 'message' | 'process' | 'operation';
  searchTargetItemId?: string;
}

function StreamingElapsed({ startTime, statusLabel, visualState }: { startTime?: number | null; statusLabel: string; visualState: MessageVisualState }) {
  const [elapsed, setElapsed] = useState(() => startTime ? Date.now() - startTime : 0);

  useEffect(() => {
    if (!startTime) return;
    setElapsed(Date.now() - startTime);
    const interval = setInterval(() => setElapsed(Date.now() - startTime), 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const presentation = getRunningDurationPresentation(statusLabel, elapsed);
  return presentation
    ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
        <span className="assistant-message__status-icon" aria-hidden="true">
          <ExecutionStatusIcon status={visualState} />
        </span>
        <span>{presentation}</span>
      </span>
    )
    : null;
}

/** 判断是否为网页 URL */
function isWebUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** 智能截断过长路径：按分隔符拆分，优先保留开头和结尾，中间用 \...\ 省略
 *  根据字符预算截断，尽可能保留更多首尾目录全名 */
function truncateDisplayPath(path: string, maxChars: number = 80): string {
  if (!path || typeof path !== 'string') return '';
  if (path.length <= maxChars) return path;
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 2) return path;

  const ellipsis = sep + '...' + sep;
  const ellipsisLen = ellipsis.length;

  for (let keepFirst = Math.min(parts.length - 1, 4); keepFirst >= 1; keepFirst--) {
    for (let keepLast = Math.min(parts.length - keepFirst, 4); keepLast >= 1; keepLast--) {
      const start = parts.slice(0, keepFirst).join(sep);
      const end = parts.slice(-keepLast).join(sep);
      if (start.length + ellipsisLen + end.length <= maxChars) {
        return start + ellipsis + end;
      }
    }
  }

  return parts[0] + ellipsis + parts[parts.length - 1];
}

/** 规范化文件路径：去掉前导 /、去掉 :lineNumber 后缀、处理双斜杠 */
function normalizeFilePath(href: string): string {
  if (!href || typeof href !== 'string') return '';
  let p = href.trim();
  if (!p) return '';
  // URL decode（防止 react-markdown 对特殊字符编码）
  try { p = decodeURIComponent(p); } catch {}
  // 去掉前导 /（如 /G:/... → G:/...）
  p = p.replace(/^\/+([A-Za-z]:)/, '$1');
  // 规范双斜杠 G:// → G:/
  p = p.replace(/^([A-Za-z]):\/\/+/, '$1:/');
  // 去掉锚点
  p = p.replace(/#.*$/, '');
  // 去掉 :lineNumber 后缀（如 README.md:1 → README.md）
  p = p.replace(/:(\d+)$/, '');
  return p;
}

/** 判断是否为文件路径 */
function isFilePath(href: string): boolean {
  if (!href || href.startsWith('javascript:') || href.startsWith('#')) return false;
  // 网页 URL 直接排除
  if (isWebUrl(href)) return false;

  const normalized = normalizeFilePath(href);
  if (!normalized) return false;

  // Windows 绝对路径: X:/... 或 X:\...
  if (/^[A-Za-z]:[\\\/]/.test(normalized)) return true;
  // Unix 绝对路径
  if (normalized.startsWith('/') || normalized.startsWith('~/')) return true;
  // 带常见文件扩展名（不论是不是相对路径，只要有扩展名就可能是文件）
  if (/\.\w{1,10}$/i.test(normalized)) return true;
  // 包含路径分隔符的相对路径（如 server/src/index.ts）
  if (/[\\\/]/.test(normalized) && /\.\w+$/i.test(normalized)) return true;

  return false;
}

function isAbsoluteFilePath(path: string): boolean {
  const normalized = normalizeFilePath(path);
  return /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('/') || normalized.startsWith('~/');
}

const KNOWN_EXTENSIONLESS_FILES = new Set(['LICENSE', 'Makefile', 'Dockerfile', 'Procfile']);
const KNOWN_DOTFILES = new Set(['.env', '.gitignore', '.gitattributes', '.npmrc', '.editorconfig', '.dockerignore']);

function isLikelyAbsoluteFilePath(path: string): boolean {
  if (!isAbsoluteFilePath(path)) return false;
  const normalized = normalizeFilePath(path).replace(/[\\/]+$/, '');
  const fileName = normalized.split(/[\\/]/).pop() || '';
  return /.+\.[A-Za-z0-9]{1,10}$/.test(fileName)
    || KNOWN_DOTFILES.has(fileName)
    || KNOWN_EXTENSIONLESS_FILES.has(fileName);
}

const ABSOLUTE_FILE_PATH_PATTERN = /([A-Za-z]:[\\/](?:[^<>:"|?*\s]+[\\/])*(?:[^<>:"|?*\s]+\.[A-Za-z0-9]{1,10}|\.[A-Za-z0-9][A-Za-z0-9._-]{0,63})|\/(?:[^/\s<>]+\/)+(?:[^/\s<>]+\.[A-Za-z0-9]{1,10}|\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}))/g;

function linkifyAbsoluteFilePaths(text: string, keyPrefix: string, readOnly = false): ReactNode[] {
  return text.split(ABSOLUTE_FILE_PATH_PATTERN).filter(Boolean).map((part, index) => (
    isLikelyAbsoluteFilePath(part)
      ? <MarkdownLink key={`${keyPrefix}-${index}`} href={part} readOnly={readOnly}>{part}</MarkdownLink>
      : <Fragment key={`${keyPrefix}-${index}`}>{part}</Fragment>
  ));
}

function linkifyTextChildren(children: ReactNode, readOnly = false): ReactNode {
  let textIndex = 0;
  return Children.map(children, (child) => (
    typeof child === 'string'
      ? linkifyAbsoluteFilePaths(child, `path-${textIndex++}`, readOnly)
      : child
  ));
}

function containsAbsoluteFilePathLine(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const value = line.trim().replace(/^`|`$/g, '');
    return isLikelyAbsoluteFilePath(value);
  });
}

/** Markdown 链接组件 —— 文件路径在右侧面板打开，其他 URL 在新标签打开 */
function MarkdownLink({ href, children, projectPath, readOnly = false }: { href: string; children: React.ReactNode; projectPath?: string; readOnly?: boolean }) {
  const openFilePreview = useFilePreview();
  const codexReference = decodeCodexFileReference(href);

  if (codexReference) {
    return <CodexFileReference reference={codexReference} projectPath={projectPath} readOnly={readOnly} />;
  }

  const web = isWebUrl(href);
  const file = isFilePath(href);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (hasExpandedSelectionWithin(e.currentTarget)) return;
    console.log('[MarkdownLink] handleClick, href="' + href + '", web=' + web + ', file=' + file);
    if (web) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!file) return;
    void openFilePreview(normalizeFilePath(href));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (web) {
        window.open(href, '_blank', 'noopener,noreferrer');
      } else if (file) {
        void openFilePreview(normalizeFilePath(href));
      }
    }
  };

  if (file) {
    const fullPath = normalizeFilePath(href);
    const displayPath = truncateDisplayPath(fullPath);
    const linkText = typeof children === 'string' ? children : '';
    // 如果 children 就是完整路径，则显示截断版本；否则保留原始 children
    const showText = linkText === fullPath || linkText.includes('\\') || linkText.includes('/')
      ? truncateDisplayPath(linkText)
      : linkText || displayPath;
    if (readOnly) return <Tooltip overflowOnly content={fullPath} asChild><span data-tooltip-full-text={fullPath} className="md-link-file cursor-default">{showText}</span></Tooltip>;
    return (
      <Tooltip content={`点击预览文件：${fullPath}`} inline>
        <span
          onClick={handleClick}
          className="md-link-file"
          role="button"
          tabIndex={0}
          aria-label={`预览文件：${fullPath}`}
          onKeyDown={handleKeyDown}
        >
          <FileTypeIcon filePath={fullPath} className="inline-block mr-0.5 -mt-0.5 shrink-0 opacity-70" />
          {showText}
        </span>
      </Tooltip>
    );
  }

  if (readOnly && !web) return <span>{children}</span>;

  // 网址链接：保留超链接样式 + 外联跳转图标
  return (
    <Tooltip content={`点击打开网页：${href}`} inline>
      <a href={href} onClick={handleClick} target="_blank" rel="noopener noreferrer" className="md-link-web">
        {children}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="inline-block ml-0.5 -mt-0.5 shrink-0 opacity-50">
          <path d="M10 2H6M10 2v4M10 2L3 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </a>
    </Tooltip>
  );
}

/** 代码块组件 —— 带语言标签和复制按钮，配色用 CSS 变量便于主题切换 */
const CodeBlock = memo(function CodeBlock({ language, code, renderedCode, readOnly = false }: { language: string; code: string; renderedCode: ReactNode; readOnly?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    copyToClipboard(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [code]);

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-[var(--color-code-border)]">
      {/* Header：语言标签 + 复制按钮 */}
      <div data-message-copy-exclude className="flex items-center justify-between px-3 py-1 bg-[var(--color-code-header)] border-b border-[var(--color-code-border)]">
        <span className="text-xs text-[var(--color-code-muted)] font-mono select-none">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-[var(--color-code-muted)] hover:text-[var(--color-code-text)] transition-colors"
        >
          {copied ? (
            <>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span>已复制</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <rect x="5" y="5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M3 11V3a1 1 0 011-1h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      {/* 代码内容 —— 直接 pre，无额外包裹 */}
      <pre className="!m-0 !rounded-none !border-0 !bg-[var(--color-code-bg)] !rounded-b-lg">
        <code className={`language-${language} hljs`}>
          {containsAbsoluteFilePathLine(code) ? linkifyAbsoluteFilePaths(code, 'code-path', readOnly) : renderedCode}
        </code>
      </pre>
    </div>
  );
});

function createMarkdownComponents(readOnly: boolean, projectPath?: string) { return {
  a({ href, children }: any) {
    return <MarkdownLink href={href || ''} projectPath={projectPath} readOnly={readOnly}>{children}</MarkdownLink>;
  },
  img({ src, alt, title, node: _node, ...props }: any) {
    if (shouldRenderMarkdownImageAsFileLink(src)) {
      const label = alt?.trim() || normalizeFilePath(src) || '图片文件';
      return <MarkdownLink href={src} readOnly={readOnly}>{label}</MarkdownLink>;
    }
    if (readOnly) {
      const label = alt?.trim() || src || '图片';
      return <Tooltip content={src || undefined} asChild><span className="md-link-file cursor-default">[图片：{label} · 未包含图片内容]</span></Tooltip>;
    }
    return <Tooltip content={title} asChild><img {...props} src={src} alt={alt || ''} /></Tooltip>;
  },
  p({ children, node: _node, ...props }: any) {
    return <p {...props}>{linkifyTextChildren(children, readOnly)}</p>;
  },
  li({ children, node: _node, ...props }: any) {
    return <li {...props}>{linkifyTextChildren(children, readOnly)}</li>;
  },
  pre({ children, node, ...props }: any) {
    const codeChild = node?.children?.[0];
    const cls = codeChild?.properties?.className;
    const hasLang = Array.isArray(cls) && cls.some((value: string) => value.startsWith('language-'));
    const codeText = extractMarkdownCodeText(codeChild, undefined);
    const isFilePathBlock = codeChild?.tagName === 'code' && containsAbsoluteFilePathLine(codeText);
    if (codeChild?.tagName === 'code' && (hasLang || isFilePathBlock)) return <>{children}</>;
    return <pre {...props}>{children}</pre>;
  },
  code({ inline, className, children, node, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : '';
    const codeContent = extractMarkdownCodeText(node, children).replace(/\n$/, '');
    if (!inline && (language || containsAbsoluteFilePathLine(codeContent))) {
      return <CodeBlock language={language || 'text'} code={codeContent} renderedCode={children} readOnly={readOnly} />;
    }
    if (inline && isLikelyAbsoluteFilePath(codeContent.trim())) {
      const path = codeContent.trim();
      return <MarkdownLink href={path} readOnly={readOnly}>{path}</MarkdownLink>;
    }
    return <code className={className} {...props}>{children}</code>;
  },
}; }

/** 将行首中文数字序号转换为标准 Markdown 有序列表，代码围栏内保持原样。 */
function normalizeChineseNumberedLists(content: string): string {
  let fenceMarker: '`' | '~' | null = null;
  return content.split(/\r?\n/).map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0] as '`' | '~';
      fenceMarker = fenceMarker === marker ? null : marker;
      return line;
    }
    if (fenceMarker) return line;
    const numberedLine = line.replace(/^(\s*)(\d+)[。．、]\s*/, '$1$2. ');
    return numberedLine.split(/(`+[^`]*`+|(?:::codex-inline-vis|::artifact-template|:codex-file-citation)\{[^}]*\})/g).map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment.replace(ABSOLUTE_FILE_PATH_PATTERN, (filePath) => (
        filePath.includes('\\') ? filePath.replace(/\\/g, '\\\\') : filePath
      ));
    }).join('');
  }).join('\n');
}

const MarkdownContent = memo(function MarkdownContent({ content, projectPath, readOnly = false, enableCodexDirectives = false }: { content: string; projectPath?: string; readOnly?: boolean; enableCodexDirectives?: boolean }) {
  const normalizedContent = normalizeChineseNumberedLists(content);
  return (
    <ReactMarkdown
      remarkPlugins={enableCodexDirectives
        ? [remarkGfm, remarkRelaxedStrong, remarkCodexFileDirectives, remarkHtmlBreak]
        : [remarkGfm, remarkRelaxedStrong, remarkHtmlBreak]}
      rehypePlugins={[rehypeHighlight]}
      components={createMarkdownComponents(readOnly, projectPath)}
      urlTransform={(url) => url}
    >
      {normalizedContent}
    </ReactMarkdown>
  );
});

function AssistantMessage({ historicalRecords, historicalRecordCount, sessionId, content, isStreaming, isStopping, isAwaitingAction, pendingActionKind, isRecovering, duration, startTime, createdAt, items, processContent, processTimeline, changedFiles, changedFilesIncomplete = false, hasDetails = false, detailsLoaded = false, processItemCount = 0, asyncQuestionIds, processNarrativeCount = 0, changedFileCount = 0, onLoadDetails, deferMarkdown = false, optimizeContentVisibility = false, projectPath, mobile = false, streamingSteps, stopped, outcome, executionStage, waitingStage, errorCode, errorMessage, tokenUsage, modelInfo, onInteractionRespond, onAsyncQuestionAnswer, answeredAsyncQuestionIds, asyncQuestionAnswers, canAnswerAsyncQuestion, readOnly = false, full, onShare, onSelectMessagesShare, onFork, forkPending = false, selectionMode = false, selected = false, selectable = true, onToggleSelection, messageId, searchTarget = false, searchTargetScope, searchTargetItemId, onResync, flowContext }: Props) {
  const [copied, setCopied] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [detailsStatus, setDetailsStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const contentRef = useRef<HTMLDivElement>(null);
  const openFilePreview = useFilePreview();

  const handleCopy = useCallback(() => {
    const textToCopy = showSource
      ? content
      : getRenderedMessageCopyText(contentRef.current) ?? content;
    copyToClipboard(textToCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [content, showSource]);

  // createdAt 是服务端保存完成消息的时间，已经代表真实完成时刻。
  const completionTime = !isStreaming ? (createdAt ?? null) : null;
  const stage = executionStage || (content || processContent || items?.length ? 'responding' : 'accepted');
  const visualState: MessageVisualState = isStreaming
    ? (isStopping ? 'stopping' : isAwaitingAction ? 'awaiting_action' : isRecovering ? 'recovering' : 'processing')
    : outcome || (stopped ? 'stopped' : 'completed');
  const operationRecord = !isStreaming && !stopped && !content.trim() && (!outcome || outcome === 'completed') && !errorCode;
  const status = operationRecord
    ? { label: '操作记录', tone: 'warning' as const }
    : getMessageStatusPresentation(visualState, stage, errorMessage, errorCode, waitingStage, pendingActionKind, canAnswerAsyncQuestion === true && !readOnly);
  const settledDurationPresentation = !isStreaming
    ? getSettledDurationPresentation(completionTime ?? undefined, status.label, duration, Date.now(), mobile)
    : null;
  const processSteps = isStreaming ? streamingSteps || [] : items || flowContext?.steps || [];
  const effectiveProcessTimeline = processTimeline || flowContext?.timeline;
  const hasVisibleProcess = hasVisibleProcessPresentation(processContent, processSteps, effectiveProcessTimeline);
  const hasPriorityProcessItem = hasPendingInteraction(processSteps.filter((step) => !answeredAsyncQuestionIds?.has(step.id)));
  const displayContent = visualState === 'failed' && content === errorMessage ? '' : content;
  const safeToRetry = isMessageSafeToRetry({
    finalContent: displayContent,
    processContent,
    items: processSteps,
    changedFileCount,
    processItemCount,
    processNarrativeCount,
    detailsLoaded: detailsLoaded || Boolean(items || processContent || processTimeline),
  });
  const errorGuidance = getMessageErrorGuidance(errorCode, errorMessage, { safeToRetry });
  const statusDescription = status.detail && status.detail !== errorMessage ? status.detail : undefined;
  const errorDescription = statusDescription || errorGuidance?.description;
  const expandProcessWithoutFinalReply = shouldExpandProcessWithoutFinalReply(
    Boolean(isStreaming),
    processSteps.length > 0 || Boolean(processContent),
    displayContent,
  );
  const hasLoadedDetails = detailsLoaded || Boolean(items || processContent || processTimeline);
  const detailCount = processItemCount + processNarrativeCount + changedFileCount;
  const loadDetails = useCallback(() => {
    if (!onLoadDetails || detailsStatus === 'loading') return;
    setDetailsStatus('loading');
    void onLoadDetails().then(
      () => setDetailsStatus('idle'),
      () => setDetailsStatus('error'),
    );
  }, [detailsStatus, onLoadDetails]);

  const needsAsyncQuestionDetails = !hasLoadedDetails && Boolean(asyncQuestionIds?.length);
  useEffect(() => {
    if (needsAsyncQuestionDetails && detailsStatus === 'idle') loadDetails();
  }, [needsAsyncQuestionDetails, detailsStatus, loadDetails]);

  useEffect(() => {
    if (hasLoadedDetails) setDetailsStatus('idle');
  }, [hasLoadedDetails]);

  const messageActionItems: MessageActionItem[] = [];
  if (mobile && !readOnly && displayContent) {
    messageActionItems.push({
      key: 'copy',
      label: copied ? '已复制' : '复制',
      onClick: handleCopy,
      icon: <CopyIcon copied={copied} />,
    });
  }
  if (!readOnly && displayContent) {
    messageActionItems.push({
      key: 'source',
      label: showSource ? '渲染显示' : '源码显示',
      onClick: () => setShowSource(!showSource),
      icon: <MenuIcon type={showSource ? 'render' : 'source'} />,
    });
  }
  if (!readOnly && onShare) {
    messageActionItems.push({
      key: 'share',
      label: '单消息分享',
      onClick: onShare,
      icon: <MenuIcon type="share" />,
    });
  }
  if (!readOnly && onSelectMessagesShare) {
    messageActionItems.push({
      key: 'share-selection',
      label: '选择消息分享',
      onClick: onSelectMessagesShare,
      icon: <MenuIcon type="select" />,
    });
  }
  if (!readOnly && onFork) {
    messageActionItems.push({
      key: 'fork',
      label: forkPending ? '正在新建会话' : '从此处新建会话',
      onClick: onFork,
      disabled: forkPending,
      separatorBefore: messageActionItems.length > 0,
      icon: <MenuIcon type="fork" />,
    });
  }
  const showDirectCopy = Boolean(displayContent) && (!mobile || readOnly);
  const showMessageActions = messageActionItems.length > 0 || showDirectCopy;

  return (
    <div
      data-message-id={messageId}
      className={`message-row message-row--assistant flex justify-start group ${searchTarget ? 'search-target-message' : ''} ${selectionMode ? 'items-start gap-3' : ''} ${shouldDimShareMessage(selectionMode, selectable) ? 'opacity-55' : ''}`}
    >
      {selectionMode && <input type="checkbox" className="mt-4 h-4 w-4 shrink-0" checked={selected} disabled={!selectable} onChange={onToggleSelection} aria-label="选择这条助手消息" />}
      <div className={`message-shell message-shell--assistant message-bubble w-full ${optimizeContentVisibility ? 'message-bubble-content-visibility' : ''}`}>
        <div className={`message-content message-content--assistant assistant-message assistant-message--${status.tone}`}>
        <div
          className={`assistant-message__status ${isStreaming && !displayContent && !hasVisibleProcess ? 'assistant-message__status--standalone' : ''}`}
          role="status"
        >
          <div className="inline-flex flex-wrap items-center gap-1.5">
            <span className="assistant-message__status-icon" aria-hidden="true">
              <ExecutionStatusIcon status={visualState} />
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="font-medium">{status.label}</span>
              {tokenUsage && (
                <>
                  <span className="text-[var(--color-text-tertiary)]" aria-hidden="true">·</span>
                  <TokenUsageSummary tokenUsage={tokenUsage} mobile={mobile} />
                </>
              )}
            </span>
            {isStreaming && stage === 'started' && visualState === 'processing'
              && !displayContent && !hasVisibleProcess && (
              <BlankProcessingStatus startTime={startTime} onResync={onResync} />
            )}
          </div>
        </div>

        {(hasVisibleProcess || historicalRecords || flowContext) && (
          <ProcessSteps
            key={flowContext?.id || 'ordinary-process'}
            messageId={selectionMode ? undefined : messageId}
            flowContext={selectionMode ? undefined : readOnly && !flowContext?.readOnly ? undefined : flowContext}
            readOnly={readOnly}
            flowDetailsPending={!isStreaming && hasDetails && !hasLoadedDetails}
            onLoadFlowDetails={loadDetails}
            flowFinalContent={content}
            flowFinalRecordedAt={createdAt}
            flowRuntimeStatus={isStreaming ? { state: visualState, label: status.label } : undefined}
            flowOutcome={isStreaming ? undefined : outcome || (stopped ? 'stopped' : 'completed')}
            steps={processSteps}
            historicalRecords={historicalRecords}
            historicalRecordCount={historicalRecordCount}
            sessionId={sessionId}
            processContent={processContent}
            processTimeline={effectiveProcessTimeline}
            processContentDetail={processContent ? <MarkdownContent content={processContent} readOnly={readOnly} /> : undefined}
            renderNarrativeDetail={(narrative) => <MarkdownContent content={narrative} readOnly={readOnly} />}
            defaultCollapsed={!isStreaming && !hasPriorityProcessItem && !expandProcessWithoutFinalReply}
            preserveExpandedOnSettle={expandProcessWithoutFinalReply}
            settled={!isStreaming}
            narrativeStatus={isStreaming ? (isStopping ? 'stopped' : 'in_progress') : 'completed'}
            searchTargetScope={searchTargetScope}
            searchTargetItemId={searchTargetItemId}
            onInteractionRespond={readOnly ? undefined : onInteractionRespond}
            onAsyncQuestionAnswer={readOnly ? undefined : onAsyncQuestionAnswer}
            answeredAsyncQuestionIds={answeredAsyncQuestionIds}
            asyncQuestionAnswers={asyncQuestionAnswers}
            canAnswerAsyncQuestion={canAnswerAsyncQuestion}
            full={full}
          />
        )}

        {!isStreaming && hasDetails && !hasLoadedDetails && (
          <div
            className="message-inline-feedback message-inline-feedback--details mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-text-secondary)]"
            role="status"
            aria-live="polite"
          >
            <span>{detailCount > 0 ? `处理详情共 ${detailCount} 项` : '此消息包含处理详情'}</span>
            <button
              type="button"
              className="message-inline-feedback__action"
              disabled={!onLoadDetails || detailsStatus === 'loading'}
              onClick={loadDetails}
            >
              {detailsStatus === 'loading' ? '正在加载详情…' : detailsStatus === 'error' ? '加载失败，点击重试' : '加载详情'}
            </button>
          </div>
        )}

        {/* 消息内容 */}
        {displayContent && (showSource ? (
          <pre data-search-content className="theme-message-content text-[var(--color-text)] bg-[var(--color-bg-secondary)] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
{displayContent}
          </pre>
        ) : isStreaming ? (
          /* 流式中不执行 Markdown 解析和代码高亮，完成后再统一渲染 */
          <div data-search-content className="theme-message-content text-[var(--color-text)] whitespace-pre-wrap break-words">
            {displayContent}
            {!isStopping && <span className="streaming-cursor-inline">●●●</span>}
          </div>
        ) : (
          /* 最终完成消息使用完整 Markdown 和代码高亮 */
          <div ref={contentRef} data-search-content className="markdown-body theme-message-content text-[var(--color-text)]">
            <DeferredMarkdownContent
              content={displayContent}
              defer={deferMarkdown}
              renderMarkdown={(value) => <MarkdownContent content={value} projectPath={projectPath} readOnly={readOnly} enableCodexDirectives />}
            />
          </div>
        ))}

        {(errorDescription || errorMessage || errorCode) && (
          <div className="message-feedback message-feedback--error assistant-message__detail">
            {errorDescription && <div>{errorDescription}</div>}
            {errorGuidance?.suggestion && <div className="mt-1">{errorGuidance.suggestion}</div>}
            {(errorMessage || errorCode) && (
              <div className={errorDescription || errorGuidance?.suggestion ? 'mt-2' : undefined}>
                <span className="font-medium">原始异常：</span>
                {errorMessage && <span className="assistant-message__raw-error">{errorMessage}</span>}
                {errorCode && <span className="ml-2 font-mono text-[10px] opacity-70">{errorCode}</span>}
              </div>
            )}
          </div>
        )}

        {!isStreaming && changedFiles && changedFiles.length > 0 && (
          <ChangedFilesSummary
            files={changedFiles}
            changedFilesIncomplete={changedFilesIncomplete}
            outcome={outcome}
            projectPath={projectPath}
            mobile={mobile}
            readOnly={readOnly}
            full={full}
            onOpenFile={openFilePreview}
          />
        )}
        {!isStreaming && changedFilesIncomplete && (!changedFiles || changedFiles.length === 0) && (
          <div className="mb-3">
            <ChangedFilesIncompleteNotice />
          </div>
        )}
        </div>

        {/* 底部操作栏 */}
        {isStreaming ? (
          <div className="flex items-center gap-2 mt-2">
            <StreamingElapsed startTime={startTime} statusLabel={status.label} visualState={visualState} />
          </div>
        ) : (
          <div className="message-support message-support--assistant message-meta message-meta--assistant justify-start">
            {settledDurationPresentation && (
              <span className="message-meta__facts text-xs text-[var(--color-text-tertiary)]">{settledDurationPresentation}</span>
            )}
            {modelInfo && <>
              {settledDurationPresentation && <span className="message-meta__separator shrink-0" aria-hidden="true">·</span>}
              <MessageModelInfo modelInfo={modelInfo} mobile={mobile} readOnly={readOnly} />
            </>}
            {showMessageActions && <div
              className="message-actions message-actions--compact flex items-center"
              onPointerUp={(event) => event.stopPropagation()}
            >
              {showDirectCopy && (
                <ActionButton onClick={handleCopy} title="复制">
                  <CopyIcon copied={copied} />
                </ActionButton>
              )}
              <MessageActionsMenu items={messageActionItems} mobile={mobile} />
            </div>}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  title,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={title}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={title}
        className="message-action-button"
      >
        {children}
      </button>
    </Tooltip>
  );
}

export default memo(AssistantMessage);
