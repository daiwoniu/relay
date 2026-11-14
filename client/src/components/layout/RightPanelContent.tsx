import FailureNotice from '../ui/FailureNotice';
import { lazy, Suspense, useEffect, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { HtmlPreviewMode, RightPanelTab } from '../../stores/chat';
import HoverCard from '../ui/HoverCard';
import IconActionButton from '../ui/IconActionButton';
import Modal from '../ui/Modal';
import FileTypeIcon from '../messages/FileTypeIcon';
import ProgressiveCodePreview from './ProgressiveCodePreview';
import { formatGitDiffHunkHeader } from './git-diff-hunk';
import { readFileGitDiff, type FileGitDiffResult } from '../../api/filesystem';
import PreviewState from './PreviewState';
import {
  buildCodePreviewMarkdown,
  buildPreviewLineNumbers,
  isLargeCodePreview,
  MAX_PREVIEW_LINE_NUMBERS,
  shouldUseHtmlVisualization,
} from './file-preview-lines';
import {
  formatFileMetadataSize,
  formatFileMetadataTime,
  getFileMetadataTypeLabel,
} from './file-preview-metadata';

const PdfDocumentPreview = lazy(() => import('./PdfDocumentPreview'));
const WordDocumentPreview = lazy(() => import('./WordDocumentPreview'));
const SpreadsheetPreview = lazy(() => import('./SpreadsheetPreview'));

type MobileInfo = 'force-access' | 'file-info' | null;

interface FileMetadataContentProps {
  filePath: string;
  metadata: RightPanelTab['fileMetadata'];
  loading?: boolean;
  error?: string;
  copiedPath: boolean;
  onCopyPath: (filePath: string) => void;
}

export function getFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || filePath;
}

function FileMetadataContent({ filePath, metadata, loading, error, copiedPath, onCopyPath }: FileMetadataContentProps) {
  if (loading) return <PreviewState compact tone="loading" title="正在加载文件信息" />;
  if (!metadata) {
    const errorTone = error?.includes('临时授权') ? 'warning' : 'danger';
    return <PreviewState compact tone={errorTone} title="文件信息不可用" description={error || '暂时无法读取文件信息'} />;
  }
  const resolvedPath = metadata.path || filePath;
  const fileName = getFileName(resolvedPath);

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center gap-2">
        <FileTypeIcon filePath={resolvedPath} size={18} className="shrink-0 text-[var(--color-text-secondary)]" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[var(--color-text)]" title={fileName}>{fileName}</div>
          <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">
            {getFileMetadataTypeLabel(resolvedPath)} · {formatFileMetadataSize(metadata.size)}
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
        <dt className="text-[var(--color-text-tertiary)]">修改时间</dt>
        <dd className="text-[var(--color-text-secondary)]">{formatFileMetadataTime(metadata.modifiedAt)}</dd>
        <dt className="text-[var(--color-text-tertiary)]">创建时间</dt>
        <dd className="text-[var(--color-text-secondary)]">{formatFileMetadataTime(metadata.createdAt)}</dd>
      </dl>
      <div className="border-t border-[var(--color-border-light)] pt-2">
        <div className="mb-1 text-[11px] text-[var(--color-text-tertiary)]">完整路径</div>
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1 break-all text-xs leading-5 text-[var(--color-text-secondary)]">{resolvedPath}</div>
          <IconActionButton
            label={copiedPath ? '路径已复制' : '复制文件路径'}
            variant="neutral"
            tooltip={false}
            onClick={() => onCopyPath(resolvedPath)}
            className="h-7 w-7 shrink-0"
          >
            {copiedPath ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3 10V4.5A1.5 1.5 0 014.5 3H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            )}
          </IconActionButton>
        </div>
      </div>
    </div>
  );
}

interface RightPanelContentProps {
  tabs: RightPanelTab[];
  activeTab: RightPanelTab | undefined;
  activeTabId: string | null;
  isMobile: boolean;
  isMaximized: boolean;
  rightPanelPinned: boolean;
  copiedPath: boolean;
  mobileInfo: MobileInfo;
  forceLoadingTabId: string | null;
  compressingTabId: string | null;
  isHtmlPreview: boolean;
  sandboxedHtmlDocument: string;
  htmlPreviewHeight: number;
  htmlIframeRef: RefObject<HTMLIFrameElement | null>;
  htmlPreviewScrollRef: RefObject<HTMLDivElement | null>;
  requestSignal?: AbortSignal;
  onSelectTab: (id: string) => void;
  onCloseTab: (tab: RightPanelTab) => void;
  onHidePanel: () => void;
  onTogglePinned: () => void;
  setIsMaximized: Dispatch<SetStateAction<boolean>>;
  onCloseAllTabs: () => void;
  onCopyPath: (filePath: string) => void;
  onForceAccess: (tab: RightPanelTab) => void;
  onDownload: (tab: RightPanelTab) => void;
  onCompressedPreview: (tab: RightPanelTab) => void;
  onHtmlPreviewMode: (mode: HtmlPreviewMode) => void;
  onRequestHtmlScripts: () => void;
  setMobileInfo: Dispatch<SetStateAction<MobileInfo>>;
}

export default function RightPanelContent({
  tabs,
  activeTab,
  activeTabId,
  isMobile,
  isMaximized,
  rightPanelPinned,
  copiedPath,
  mobileInfo,
  forceLoadingTabId,
  compressingTabId,
  isHtmlPreview,
  sandboxedHtmlDocument,
  htmlPreviewHeight,
  htmlIframeRef,
  htmlPreviewScrollRef,
  requestSignal,
  onSelectTab,
  onCloseTab,
  onHidePanel,
  onTogglePinned,
  setIsMaximized,
  onCloseAllTabs,
  onCopyPath,
  onForceAccess,
  onDownload,
  onCompressedPreview,
  onHtmlPreviewMode,
  onRequestHtmlScripts,
  setMobileInfo,
}: RightPanelContentProps) {
  const hasTabs = tabs.length > 0;
  const largeCodePreview = Boolean(activeTab?.language && isLargeCodePreview(activeTab.contentSize));
  const htmlVisualizationEnabled = Boolean(
    isHtmlPreview && activeTab && shouldUseHtmlVisualization(activeTab.contentSize, activeTab.htmlPreviewMode),
  );
  const codeMarkdown = useMemo(
    () => largeCodePreview ? '' : activeTab?.language ? buildCodePreviewMarkdown(activeTab.content, activeTab.language) : '',
    [activeTab?.content, activeTab?.language, largeCodePreview],
  );
  const lineNumbers = useMemo(
    () => largeCodePreview ? [] : activeTab?.language ? buildPreviewLineNumbers(activeTab.content) : [],
    [activeTab?.content, activeTab?.language, largeCodePreview],
  );
  const [gitDiffResult, setGitDiffResult] = useState<{ tabId: string; result: FileGitDiffResult } | null>(null);
  const [gitDiffError, setGitDiffError] = useState<{ tabId: string; message: string } | null>(null);
  const [gitDiffTabId, setGitDiffTabId] = useState<string | null>(null);
  useEffect(() => {
    setGitDiffResult(null);
    setGitDiffError(null);
    setGitDiffTabId(null);
    if (!activeTab || activeTab.loading || activeTab.previewError || !activeTab.language || activeTab.forceAccessAvailable || activeTab.textPreviewTruncated) return;
    const controller = new AbortController();
    const sourcePath = activeTab.sourcePath || activeTab.title;
    void readFileGitDiff(sourcePath, activeTab.fileAccessToken, { signal: controller.signal })
      .then((result) => setGitDiffResult({ tabId: activeTab.id, result }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setGitDiffError({ tabId: activeTab.id, message: error instanceof Error ? error.message : '读取失败' });
      });
    return () => controller.abort();
  }, [activeTab?.id, activeTab?.loading, activeTab?.previewError, activeTab?.language, activeTab?.forceAccessAvailable, activeTab?.textPreviewTruncated, activeTab?.fileAccessToken, activeTab?.sourcePath, activeTab?.title]);
  const gitDiff = gitDiffResult && gitDiffResult.tabId === activeTab?.id && gitDiffResult.result.changed ? gitDiffResult.result.diff : null;
  const showGitDiff = gitDiff !== null && gitDiffTabId === activeTab?.id;
  const gitDiffLines = useMemo(() => {
    const start = gitDiff?.indexOf('\n@@') ?? -1;
    return start < 0 ? ['无逐行变更'] : gitDiff!.slice(start + 1).split('\n');
  }, [gitDiff]);
  const newFileDiff = gitDiff?.includes('\n--- /dev/null\n') ?? false;
  const gitDiffModeControl = !isHtmlPreview && gitDiff !== null ? (
    <div role="group" aria-label="文件预览模式" className={`flex shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-0.5 ${isMobile ? 'w-full' : ''}`}>
      {(['content', 'diff'] as const).map((mode) => {
        const selected = mode === 'diff' ? showGitDiff : !showGitDiff;
        return <button key={mode} type="button" aria-pressed={selected} onClick={() => setGitDiffTabId(mode === 'diff' ? activeTab!.id : null)} className={`rounded ${isMobile ? 'min-h-10 flex-1 px-3 py-2 text-xs' : 'px-2 py-0.5 text-xs'} ${selected ? 'bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-tertiary)]'}`}>{mode === 'diff' ? 'Git 变更' : '内容'}</button>;
      })}
    </div>
  ) : null;
  const htmlPreviewModeControl = isHtmlPreview && activeTab ? (
    <div
      className={`flex shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-0.5 ${isMobile ? 'w-full' : ''}`}
      role="group"
      aria-label="HTML 预览模式"
    >
      {(['visualization', 'source', ...(gitDiff !== null ? ['git-diff'] as const : [])] as const).map((mode) => {
        const selected = mode === 'git-diff' ? showGitDiff : !showGitDiff && (largeCodePreview ? mode === 'source' : (activeTab.htmlPreviewMode ?? 'source') === mode);
        const disabled = largeCodePreview && mode === 'visualization';
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              if (mode === 'git-diff') setGitDiffTabId(activeTab.id);
              else { setGitDiffTabId(null); onHtmlPreviewMode(mode); }
            }}
            className={`rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-40 ${isMobile ? 'min-h-10 flex-1 px-3 py-2 text-xs' : 'px-2 py-0.5 text-[11px]'} ${selected
              ? 'bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm'
              : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]'}`}
          >
            {mode === 'visualization' ? '可视化' : mode === 'source' ? '源码' : 'Git 变更'}
          </button>
        );
      })}
    </div>
  ) : null;
  const previewModeControl = htmlPreviewModeControl ?? gitDiffModeControl;

  return (
    <>
      <div className="workspace-preview-tabs">
        <div className="workspace-preview-tabs__scroll scrollbar-thin">
          {!hasTabs && (
            <div className="flex items-center px-3 text-sm font-medium text-[var(--color-text-secondary)] select-none">文件预览</div>
          )}
          {tabs.map((tab) => (
            <HoverCard
              key={tab.id}
              className="workspace-preview-tab-wrap"
              disabled={isMobile}
              placement="bottom"
              title="文件详情"
              content={<div className="select-all break-all text-[var(--color-text-secondary)]">{tab.title}</div>}
            >
              <div className={`workspace-preview-tab group${tab.id === activeTabId ? ' is-active theme-region-section' : ''}`}>
                <button
                  type="button"
                  onClick={() => onSelectTab(tab.id)}
                  className="workspace-preview-tab__trigger"
                >
                  <FileTypeIcon filePath={tab.sourcePath || tab.title} size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
                  <span className="truncate">{tab.title.split(/[\\/]/).pop() || tab.title}</span>
                </button>
                <IconActionButton
                  label="关闭文件"
                  variant="neutral"
                  tooltip={!isMobile}
                  className={`workspace-preview-tab__close ${isMobile ? 'is-mobile' : ''}`}
                  onClick={(event) => { event.stopPropagation(); onCloseTab(tab); }}
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                </IconActionButton>
                {tab.id === activeTabId && <div className="workspace-preview-tab__indicator" />}
              </div>
            </HoverCard>
          ))}
        </div>
        <div className="workspace-preview-panel-actions">
          {isMobile ? (
            <IconActionButton
              label="返回会话并保留预览文件"
              variant="neutral"
              tooltip={false}
              onClick={onHidePanel}
              className="workspace-preview-panel-action"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 3.5L6 8l4.5 4.5M6.5 8H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </IconActionButton>
          ) : (
            <IconActionButton
              label={rightPanelPinned ? '取消固定预览面板' : '固定预览面板'}
              variant="neutral"
              tooltip
              tooltipPlacement="bottom"
              aria-pressed={rightPanelPinned}
              onClick={onTogglePinned}
              className={`workspace-preview-panel-action${rightPanelPinned ? ' is-pressed' : ''}`}
            >
              {rightPanelPinned ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 1.5v3.5l3 4v2.5H3.5V9l3-4V1.5h3zM7.5 11v4" fill="currentColor"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g transform="rotate(-45 8 8)"><path d="M9.5 1.5v3.5l3 4v2.5H3.5V9l3-4V1.5h3z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/><path d="M7.5 11v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></g></svg>
              )}
            </IconActionButton>
          )}
          {!isMobile && (
            <IconActionButton
              label={isMaximized ? '还原预览面板' : '最大化预览面板'}
              variant="neutral"
              tooltip
              tooltipPlacement="bottom"
              aria-pressed={isMaximized}
              onClick={() => setIsMaximized((maximized) => !maximized)}
              className={`workspace-preview-panel-action${isMaximized ? ' is-pressed' : ''}`}
            >
              {isMaximized ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-icon="collapse-corners"><path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-icon="expand-corners"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M2.5 10v3.5H6M13.5 10v3.5H10" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/></svg>
              )}
            </IconActionButton>
          )}
          <IconActionButton
            label="清空预览文件并关闭面板"
            variant="neutral"
            tooltip={!isMobile}
            tooltipPlacement="bottom"
            onClick={onCloseAllTabs}
            className="workspace-preview-panel-action"
          >
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </IconActionButton>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {!hasTabs ? (
          <PreviewState title="还没有打开文件" description="在会话消息中点击文件链接，即可在这里预览内容。" />
        ) : !activeTab ? null : activeTab.loading ? (
          <PreviewState tone="loading" title="正在读取文件" description="文件准备好后会自动显示。" />
        ) : (
          <>
            <div className="workspace-preview-context theme-region-section">
              <FileTypeIcon filePath={activeTab.sourcePath || activeTab.title} size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <input type="text" readOnly value={activeTab.title} onFocus={(event) => event.currentTarget.select()} className="min-w-0 flex-1 rounded bg-transparent text-xs text-[var(--color-text-secondary)] outline-none selection:bg-[var(--color-sidebar-active)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]" aria-label="文件路径" />
              {!isMobile && previewModeControl}
              <IconActionButton label={copiedPath ? '路径已复制' : '复制文件路径'} variant="neutral" tooltip={!isMobile} onClick={() => onCopyPath(activeTab.title)} className={isMobile ? 'h-10 w-10' : 'h-7 w-7'}>
                {copiedPath ? (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3 10V4.5A1.5 1.5 0 014.5 3H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                )}
              </IconActionButton>
              <HoverCard disabled={isMobile} placement="bottom" title="文件信息" content={<FileMetadataContent filePath={activeTab.sourcePath || activeTab.title} metadata={activeTab.fileMetadata} loading={activeTab.fileMetadataLoading} error={activeTab.forceAccessAvailable ? '临时授权后可查看文件信息' : activeTab.fileMetadataError} copiedPath={copiedPath} onCopyPath={onCopyPath} />}>
                <IconActionButton label="文件信息" variant="neutral" tooltip={false} overlayIgnore={false} onClick={() => setMobileInfo('file-info')} className={isMobile ? 'h-10 w-10' : 'h-7 w-7'}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-icon="file-metadata-info"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M8 7v4M8 4.8v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                </IconActionButton>
              </HoverCard>
              {activeTab.forceAccessAvailable ? (
                <div className="flex shrink-0 items-center gap-1">
                  {isMobile && (
                    <IconActionButton label="了解临时授权" variant="neutral" tooltip={false} className="h-10 w-10" onClick={() => setMobileInfo('force-access')}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-icon="file-access-info"><path d="M8 2.2l4.5 1.7v3.4c0 2.8-1.8 5.1-4.5 6.5-2.7-1.4-4.5-3.7-4.5-6.5V3.9L8 2.2z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><path d="M6.5 8l1 1 2-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </IconActionButton>
                  )}
                  <HoverCard disabled={isMobile} placement="bottom" title="临时文件授权" content={<div className="text-[var(--color-text-secondary)]">权限仅适用于当前文件和本次打开，关闭标签后会撤销。</div>}>
                    <button type="button" onClick={() => onForceAccess(activeTab)} disabled={forceLoadingTabId === activeTab.id} className={`shrink-0 rounded px-2 text-xs text-[var(--color-status-warning)] transition-colors hover:bg-[var(--color-warning-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:opacity-50 ${isMobile ? 'min-h-10 py-2' : 'py-1'}`}>
                      {forceLoadingTabId === activeTab.id ? '授权中…' : '强制访问'}
                    </button>
                  </HoverCard>
                </div>
              ) : (
                <IconActionButton label="下载文件" variant="neutral" tooltip={!isMobile} onClick={() => onDownload(activeTab)} className={isMobile ? 'h-10 w-10' : 'h-7 w-7'}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v8m0 0L5 7m3 3l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </IconActionButton>
              )}
            </div>
            {isMobile && previewModeControl && <div className="theme-region-section shrink-0 border-b border-[var(--color-border)] px-3 py-2">{previewModeControl}</div>}
            {gitDiffError?.tabId === activeTab.id && <div className="workspace-preview-notice is-warning" role="status">Git 变更不可用：<FailureNotice error={gitDiffError.message} /></div>}
            <div ref={htmlPreviewScrollRef} className="flex-1 min-h-0 overflow-auto">
              {activeTab.textPreviewTruncated && !activeTab.previewError && <div className="workspace-preview-notice is-warning is-compact" role="status">文件 {formatFileMetadataSize(activeTab.contentSize ?? activeTab.fileMetadata?.size ?? NaN)}，超过 3 MB；仅显示开头（最多 100 行 / 64 KB）。</div>}
              {activeTab.previewError ? (
                <PreviewState
                  tone={activeTab.forceAccessAvailable ? 'warning' : 'danger'}
                  title="文件预览失败"
                  description={activeTab.previewError}
                />
              ) : showGitDiff ? (
                <div className="py-2 font-mono text-xs leading-5">
                  {gitDiffLines.length > 4000 && <div className="workspace-preview-notice is-info">仅显示前 4000 行。</div>}
                  {gitDiffLines.slice(0, 4000).map((line, index) => {
                    const hunk = line[0] === '@';
                    return <div key={index} className={`git-diff-row ${line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : hunk ? 'hunk' : ''}`}>{hunk ? formatGitDiffHunkHeader(line, newFileDiff) : line}</div>;
                  })}
                </div>
              ) : activeTab.documentPreview ? (
                <Suspense fallback={<PreviewState tone="loading" title="正在加载文档预览" />}>
                  {activeTab.documentPreview.type === 'pdf-document' ? (
                    <PdfDocumentPreview document={activeTab.documentPreview} onDownload={() => onDownload(activeTab)} />
                  ) : activeTab.documentPreview.type === 'word-document' ? (
                    <WordDocumentPreview document={activeTab.documentPreview} />
                  ) : (
                    <SpreadsheetPreview document={activeTab.documentPreview} sourcePath={activeTab.sourcePath || activeTab.title} accessToken={activeTab.fileAccessToken} requestSignal={requestSignal} />
                  )}
                </Suspense>
              ) : activeTab.isImage && activeTab.imageUrl ? (
                <div className="flex items-center justify-center p-4 min-h-full">
                  <img src={activeTab.imageUrl} alt={activeTab.title} className="max-w-full max-h-full rounded-lg" onError={(event) => { event.currentTarget.style.display = 'none'; event.currentTarget.nextElementSibling?.classList.remove('hidden'); }} />
                  <PreviewState hidden tone="danger" title="图片加载失败" description="文件可能已移动、损坏或当前格式无法显示。" />
                </div>
              ) : activeTab.compressedPreviewAvailable ? (
                <PreviewState
                  tone="warning"
                  title="需要生成轻量预览"
                  description={activeTab.content}
                  action={<button type="button" disabled={compressingTabId === activeTab.id} onClick={() => onCompressedPreview(activeTab)} className="workspace-preview-state__button">
                      {compressingTabId === activeTab.id ? '压缩中…' : '压缩后预览'}
                  </button>}
                />
              ) : htmlVisualizationEnabled ? (
                <div className="min-h-full bg-transparent">
                  {!activeTab.htmlPreviewScriptsEnabled && (
                    <div className="workspace-preview-notice is-warning">
                      <div><div className="font-medium text-[var(--color-text)]">普通 HTML 默认禁用脚本</div><div className="mt-0.5">静态内容可以直接查看；仅在确认文件可信时启用交互脚本。</div></div>
                      <button type="button" onClick={onRequestHtmlScripts} className="min-h-10 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">启用脚本</button>
                    </div>
                  )}
                  <iframe ref={htmlIframeRef} className="block min-h-[20rem] w-full border-0 bg-transparent" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={sandboxedHtmlDocument} style={{ height: `${htmlPreviewHeight}px` }} title={`HTML 可视化：${activeTab.title}`} />
                </div>
              ) : activeTab.language ? (
                <div className="right-panel-code-preview markdown-body">
                  {largeCodePreview && !activeTab.textPreviewTruncated && <div className="workspace-preview-notice is-info right-panel-line-number-notice">大文件已关闭语法高亮和行号，正在分帧加载完整内容</div>}
                  {lineNumbers === null && <div className="workspace-preview-notice is-info right-panel-line-number-notice">行数超过 {MAX_PREVIEW_LINE_NUMBERS.toLocaleString()}，已隐藏行号以保证预览性能</div>}
                  <div className={`right-panel-code-frame ${largeCodePreview || lineNumbers === null ? 'is-line-number-hidden' : ''}`}>
                    {largeCodePreview ? (
                      <ProgressiveCodePreview key={activeTab.id} content={activeTab.content} />
                    ) : (
                      <>
                        {lineNumbers !== null && <pre className="right-panel-line-numbers" aria-hidden="true">{lineNumbers}</pre>}
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{codeMarkdown}</ReactMarkdown>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-4 text-sm leading-relaxed text-[var(--color-text)] whitespace-pre-wrap break-words">{activeTab.content}</div>
              )}
            </div>
          </>
        )}
      </div>

      <Modal open={mobileInfo !== null} onClose={() => setMobileInfo(null)} labelledBy="preview-mobile-info-title" containerClassName={isMobile ? '!items-end !p-0' : ''} contentClassName={`w-full border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] p-4 shadow-[var(--color-overlay-shadow)] ${isMobile ? 'max-w-none rounded-t-2xl border-b-0' : 'max-w-sm rounded-2xl'}`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div id="preview-mobile-info-title" className="text-sm font-medium text-[var(--color-text)]">{mobileInfo === 'file-info' ? '文件信息' : '临时授权说明'}</div>
          <IconActionButton label={mobileInfo === 'file-info' ? '关闭文件信息' : '关闭说明'} variant="neutral" tooltip={false} onClick={() => setMobileInfo(null)}><svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></IconActionButton>
        </div>
        {mobileInfo === 'file-info' && activeTab ? (
          <FileMetadataContent filePath={activeTab.sourcePath || activeTab.title} metadata={activeTab.fileMetadata} loading={activeTab.fileMetadataLoading} error={activeTab.forceAccessAvailable ? '临时授权后可查看文件信息' : activeTab.fileMetadataError} copiedPath={copiedPath} onCopyPath={onCopyPath} />
        ) : (
          <div className="space-y-1 text-xs text-[var(--color-text-secondary)]"><div className="font-medium text-[var(--color-text)]">仅临时授权当前文件</div><div>授权不会扩大到目录，关闭当前文件标签后会自动撤销。</div></div>
        )}
      </Modal>
    </>
  );
}
