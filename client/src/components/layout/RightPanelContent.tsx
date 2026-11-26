import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Dispatch, type RefObject, type SetStateAction } from 'react';
import ReactMarkdown from 'react-markdown';
import { featureAction } from '../../analytics/features';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { RightPanelTab } from '../../stores/chat';
import Tooltip from '../ui/Tooltip';
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu';
import { useAuth } from '../../auth/AuthContext';
import IconActionButton from '../ui/IconActionButton';
import ExpandCornersIcon from '../ui/ExpandCornersIcon';
import Modal from '../ui/Modal';
import FileTypeIcon from '../messages/FileTypeIcon';
import PageHostingIcon from '../icons/PageHostingIcon';
import ProgressiveCodePreview from './ProgressiveCodePreview';
import { formatGitDiffHunkHeader } from './git-diff-hunk';
import { readFileGitDiff, type FileGitDiffResult } from '../../api/filesystem';
import PreviewState from './PreviewState';
import ImageFilePreview from './ImageFilePreview';
import { getFilePreviewView, isMarkdownPreview, supportsRenderedPreview, type FilePreviewView } from './file-preview-view';
import { attachPreviewScrollRestoration, type PreviewScrollPosition } from './preview-scroll-restoration';
import { revealPreviewTab } from './preview-tab-scroll';
import { buildStandaloneHtmlPreview } from './html-preview-document';
import {
  buildCodePreviewMarkdown,
  buildPreviewLineNumbers,
  isLargeCodePreview,
  MAX_PREVIEW_LINE_NUMBERS,
} from './file-preview-lines';
import {
  formatFileMetadataSize,
  formatFileMetadataTime,
  getFileMetadataTypeLabel,
} from './file-preview-metadata';

const PREVIEW_ACTION_ICON_PATHS: Record<string, string> = {
  refresh: 'M13 6a5.2 5.2 0 10.2 3M13 2.5V6H9.5',
  open: 'M9 2.5h4.5V7M13 3 7 9M6 3H3.5a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1H12a1 1 0 0 0 1-1V10',
  scripts: 'M6 3.5 11 8l-5 4.5z',
  download: 'M8 2v8m0 0L5 7m3 3l3-3M3 13h10',
};
const PdfDocumentPreview = lazy(() => import('./PdfDocumentPreview'));
const WordDocumentPreview = lazy(() => import('./WordDocumentPreview'));
const SpreadsheetPreview = lazy(() => import('./SpreadsheetPreview'));
const ArchivePreview = lazy(() => import('./ArchivePreview'));
const MediaFilePreview = lazy(() => import('./MediaFilePreview'));
const MarkdownFilePreview = lazy(() => import('./MarkdownFilePreview'));

type MobileInfo = 'force-access' | 'file-info' | null;

interface FileMetadataContentProps {
  filePath: string;
  metadata: RightPanelTab['fileMetadata'];
  loading?: boolean;
  error?: RightPanelTab['fileMetadataError'];
  copiedPath: boolean;
  onCopyPath: (filePath: string) => void;
}

export function getFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || filePath;
}

function FileMetadataContent({ filePath, metadata, loading, error, copiedPath, onCopyPath }: FileMetadataContentProps) {
  if (loading) return <PreviewState compact tone="loading" title="正在加载文件信息" />;
  if (!metadata) {
    const message = typeof error === 'string' ? error : error?.message;
    const errorTone = message?.includes('临时授权') ? 'warning' : 'danger';
    return <PreviewState compact tone={errorTone} title="文件信息不可用" error={error} description={message || '暂时无法读取文件信息'} />;
  }
  const resolvedPath = metadata.path || filePath;
  const fileName = getFileName(resolvedPath);

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center gap-2">
        <FileTypeIcon filePath={resolvedPath} size={18} className="shrink-0 text-[var(--color-text-secondary)]" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[var(--color-text)]">{fileName}</div>
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
  settingsOpen?: boolean;
  settingsPanel?: ReactNode;
  onOpenSettings?: () => void;
  onCloseSettings?: () => void;
  updating?: boolean;
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
  downloading?: boolean;
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
  onPreviewView: (mode: FilePreviewView) => void;
  onRefresh: (tab: RightPanelTab) => void;
  onRequestHtmlScripts: () => void;
  setMobileInfo: Dispatch<SetStateAction<MobileInfo>>;
}

export default function RightPanelContent({
  settingsOpen = false, settingsPanel, onOpenSettings, onCloseSettings, updating = false,
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
  downloading = false,
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
  onPreviewView,
  onRefresh,
  onRequestHtmlScripts,
  setMobileInfo,
}: RightPanelContentProps) {
  const { user } = useAuth();
  const [moreMenu, setMoreMenu] = useState<{tabId:string;rect:DOMRect}|null>(null);
  const [expandedActions, setExpandedActions] = useState(false);
  const contextRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const pathMeasureRef = useRef<HTMLSpanElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const extraActionsRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setMoreMenu(null), [activeTabId, activeTab?.id, settingsOpen]);
  const hasTabs = tabs.length > 0;
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const selectedTabRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = tabsScrollRef.current;
    const selected = selectedTabRef.current;
    if (!activeTab || !container || !selected) return;
    const reveal = () => revealPreviewTab(container, selected);
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeTab?.id, tabs.length]);
  useLayoutEffect(() => {
    // Reopening the already selected file starts a new load without changing its id.
    if (activeTab?.loading && tabsScrollRef.current && selectedTabRef.current) revealPreviewTab(tabsScrollRef.current, selectedTabRef.current);
  }, [activeTab?.id, activeTab?.loading]);
  const previewView = activeTab ? getFilePreviewView(activeTab) : 'source';
  const largeCodePreview = Boolean(activeTab?.language && isLargeCodePreview(activeTab.contentSize));
  const standaloneDocument = useMemo(() => (
    isHtmlPreview && activeTab && !activeTab.loading && !activeTab.previewError && !activeTab.textPreviewTruncated
      ? buildStandaloneHtmlPreview(activeTab.content, activeTab.title, activeTab.htmlPreviewScriptsEnabled === true)
      : ''
  ), [isHtmlPreview, activeTab?.content, activeTab?.title, activeTab?.loading, activeTab?.previewError, activeTab?.textPreviewTruncated, activeTab?.htmlPreviewScriptsEnabled]);
  const [standalonePreview, setStandalonePreview] = useState({ document: '', url: '' });
  useEffect(() => {
    if (!standaloneDocument) return;
    const url = URL.createObjectURL(new Blob([standaloneDocument], { type: 'text/html;charset=utf-8' }));
    setStandalonePreview({ document: standaloneDocument, url });
    return () => URL.revokeObjectURL(url);
  }, [standaloneDocument]);
  const standaloneUrl = standalonePreview.document === standaloneDocument ? standalonePreview.url : '';
  const canAddHosting = user?.role==='admin' && /\.html?$/i.test(activeTab?.sourcePath||activeTab?.title||'') && !activeTab?.previewError && !activeTab?.forceAccessAvailable;
  const extraActions: ContextMenuItem[] = activeTab ? [
    {id:'refresh',label:'刷新文件',onSelect:()=>onRefresh(activeTab)},
    ...(standaloneUrl ? [{ id: 'open', label: '在新标签页打开 HTML', onSelect: () => {
      featureAction('file_preview', 'open_external', 'preview_toolbar');
      window.open(standaloneUrl, '_blank', 'noopener,noreferrer');
    } }] : []),
    ...(standaloneUrl && largeCodePreview && !activeTab.htmlPreviewScriptsEnabled
      ? [{ id: 'scripts', label: '启用 HTML 脚本', onSelect: onRequestHtmlScripts }]
      : []),
    ...(!activeTab.forceAccessAvailable?[{id:'download',label:downloading?'正在下载文件':'下载文件',disabled:downloading||activeTab.loading,onSelect:()=>onDownload(activeTab)}]:[]),
    ...(canAddHosting?[{id:'hosting',label:'添加托管',onSelect:()=>{window.dispatchEvent(new CustomEvent('relay:open-page-hosting',{detail:{path:activeTab.sourcePath||activeTab.title}}));}}]:[]),
  ].map(action=>({...action,icon:action.id==='hosting'?<PageHostingIcon size={15}/>:<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d={PREVIEW_ACTION_ICON_PATHS[action.id]} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>})) : [];
  useLayoutEffect(() => {
    const row=contextRef.current, input=pathInputRef.current, text=pathMeasureRef.current;
    const actions=actionsRef.current, extra=extraActionsRef.current;
    if(!row||!input||!text||!actions||!extra) return;
    const measure=()=>{
      const rowStyle=getComputedStyle(row), inputStyle=getComputedStyle(input);
      text.style.font=inputStyle.font;
      text.style.letterSpacing=inputStyle.letterSpacing;
      const pixels=(value:string)=>parseFloat(value)||0;
      const available=row.clientWidth-pixels(rowStyle.paddingLeft)-pixels(rowStyle.paddingRight);
      const pathWidth=text.getBoundingClientRect().width+pixels(inputStyle.paddingLeft)+pixels(inputStyle.paddingRight)+pixels(inputStyle.borderLeftWidth)+pixels(inputStyle.borderRightWidth);
      // Always compare the full toolbar, even while extras are collapsed, to avoid resize oscillation.
      const moreWidth=moreButtonRef.current?.getBoundingClientRect().width;
      const fullActionsWidth=actions.getBoundingClientRect().width+(moreWidth===undefined?0:extra.getBoundingClientRect().width-moreWidth);
      const fits=pathWidth+fullActionsWidth+pixels(rowStyle.columnGap)+2<=available;
      setExpandedActions(fits);
      if(fits) setMoreMenu(null);
    };
    measure();
    const resize=new ResizeObserver(measure);
    for(const element of [row,actions,extra,text])resize.observe(element);
    const theme=new MutationObserver(measure);
    theme.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-text-scale','data-theme']});
    document.fonts?.addEventListener('loadingdone',measure);
    return()=>{resize.disconnect();theme.disconnect();document.fonts?.removeEventListener('loadingdone',measure);};
  },[activeTab?.id,activeTab?.title,activeTab?.loading,activeTab?.forceAccessAvailable,settingsOpen,isMobile,standaloneUrl,canAddHosting]);
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
  useEffect(() => {
    setGitDiffResult(null);
    setGitDiffError(null);
    if (!activeTab || activeTab.loading || activeTab.previewError || !activeTab.language || activeTab.forceAccessAvailable || activeTab.textPreviewTruncated) return;
    const controller = new AbortController();
    const sourcePath = activeTab.sourcePath || activeTab.title;
    void readFileGitDiff(sourcePath, activeTab.fileAccessToken, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setGitDiffResult({ tabId: activeTab.id, result }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setGitDiffError({ tabId: activeTab.id, message: error instanceof Error ? error.message : '读取失败' });
      });
    return () => controller.abort();
  }, [activeTab?.id, activeTab?.loading, activeTab?.previewError, activeTab?.language, activeTab?.forceAccessAvailable, activeTab?.textPreviewTruncated, activeTab?.fileAccessToken, activeTab?.sourcePath, activeTab?.title]);
  const gitDiff = gitDiffResult && gitDiffResult.tabId === activeTab?.id && gitDiffResult.result.changed ? gitDiffResult.result.diff : null;
  const showGitDiff = previewView === 'git-diff';
  const imageUrl = !showGitDiff && !activeTab?.previewError && activeTab?.isImage ? activeTab.imageUrl : undefined;
  const showingImage = Boolean(imageUrl);
  const gitDiffLines = useMemo(() => {
    const start = gitDiff?.indexOf('\n@@') ?? -1;
    return start < 0 ? ['无逐行变更'] : gitDiff!.slice(start + 1).split('\n');
  }, [gitDiff]);
  const newFileDiff = gitDiff?.includes('\n--- /dev/null\n') ?? false;
  const renderedPreview = Boolean(activeTab && supportsRenderedPreview(activeTab));
  const hasText = Boolean(activeTab?.language && !activeTab.previewError && !activeTab.forceAccessAvailable);
  const modes: FilePreviewView[] = [
    ...(renderedPreview ? ['preview'] as const : []),
    'source',
    ...(gitDiff !== null || showGitDiff ? ['git-diff'] as const : []),
  ];
  const previewModeControl = hasText && modes.length > 1 ? (
    <div className="workspace-preview-viewbar theme-region-section">
      <div className="workspace-preview-modes" role="group" aria-label={isHtmlPreview ? 'HTML 预览模式' : '文件预览模式'}>
        {modes.map((mode) => {
          const disabled = mode === 'preview' && (largeCodePreview || activeTab?.textPreviewTruncated);
          return <Tooltip key={mode} content="大文件或截断内容请使用源码视图" disabled={isMobile || !disabled} placement="bottom" className="workspace-preview-mode-hint"><button type="button" aria-pressed={previewView === mode} disabled={disabled} onClick={() => onPreviewView(mode)}>
            {mode === 'preview' ? (isHtmlPreview ? '可视化' : '预览') : mode === 'source' ? (renderedPreview ? '源码' : '内容') : 'Git 变更'}
          </button></Tooltip>;
        })}
      </div>
    </div>
  ) : null;

  // Keep the position of each file/view, including while hidden or refreshing.
  const scrollPositions = useRef(new Map<string, PreviewScrollPosition>());
  const scrollKey = activeTab ? `${activeTab.id}:${previewView}` : null;
  useLayoutEffect(() => {
    const element = htmlPreviewScrollRef.current;
    if (!element || !scrollKey || activeTab?.loading) return;
    if (showingImage) {
      element.scrollTo(0, 0);
      return;
    }
    return attachPreviewScrollRestoration(element, scrollPositions.current.get(scrollKey), (position) => scrollPositions.current.set(scrollKey, position));
  }, [scrollKey, activeTab?.loading, htmlPreviewScrollRef, showingImage]);
  useEffect(() => {
    const ids = new Set(tabs.map((tab) => tab.id));
    for (const key of scrollPositions.current.keys()) {
      if (!ids.has(key.slice(0, key.lastIndexOf(':')))) scrollPositions.current.delete(key);
    }
  }, [tabs]);

  return (
    <>
      <div className="workspace-preview-tabs">
        <div ref={tabsScrollRef} className="workspace-preview-tabs__scroll scrollbar-thin" role="group" aria-label="已打开文件">
          {!hasTabs && (
            <div className="flex items-center px-3 text-sm font-medium text-[var(--color-text-secondary)] select-none">文件预览</div>
          )}
          {tabs.map((tab) => (
            <div key={tab.id} ref={tab.id === activeTabId ? selectedTabRef : undefined} className="workspace-preview-tab-wrap">
              <div className={`workspace-preview-tab group${tab.id === activeTabId ? ' is-active theme-region-section' : ''}`}>
                <Tooltip overflowOnly content={getFileName(tab.title)} disabled={isMobile} placement="bottom" className="workspace-preview-tab-label">
                <button
                  type="button"
                  aria-pressed={tab.id === activeTabId}
                  onClick={() => onSelectTab(tab.id)}
                  className="workspace-preview-tab__trigger"
                >
                  <FileTypeIcon filePath={tab.sourcePath || tab.title} size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
                  <span className="truncate">{tab.title.split(/[\\/]/).pop() || tab.title}</span>
                </button>
                </Tooltip>
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
            </div>
          ))}
        </div>
        <div className="workspace-preview-panel-actions">
          {onOpenSettings && <IconActionButton label="预览设置" variant="neutral" tooltip={!isMobile} aria-pressed={settingsOpen} onClick={settingsOpen ? onCloseSettings : onOpenSettings} className="workspace-preview-panel-action"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 3h4l.6 2.4 1.3.8 2.4-.7 2 3.5-1.8 1.7v2.6l1.8 1.7-2 3.5-2.4-.7-1.3.8L14 21h-4l-.6-2.4-1.3-.8-2.4.7-2-3.5 1.8-1.7v-2.6L3.7 9l2-3.5 2.4.7 1.3-.8L10 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5"/></svg></IconActionButton>}
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
              onClick={() => {featureAction('file_preview',isMaximized?'restore':'maximize','preview_toolbar');setIsMaximized((maximized) => !maximized);}}
              className={`workspace-preview-panel-action${isMaximized ? ' is-pressed' : ''}`}
            >
              <ExpandCornersIcon expanded={isMaximized} />
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

      <div className="preview-settings-layout">
      {settingsOpen && !isMobile && <aside className="preview-settings-sidebar">{settingsPanel}</aside>}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {!hasTabs ? (
          <PreviewState title="还没有打开文件" description="在会话消息中点击文件链接，即可在这里预览内容。" />
        ) : !activeTab ? null : activeTab.loading ? (
          <PreviewState tone="loading" title="正在读取文件" description="文件准备好后会自动显示。" />
        ) : (
          <>
            <div ref={contextRef} className="workspace-preview-context theme-region-section">
              <div className="workspace-preview-identity">
                <Tooltip overflowOnly content={activeTab.title} disabled={isMobile} placement="bottom" className="workspace-preview-path-hint">
                <input ref={pathInputRef} type="text" readOnly value={activeTab.title} onFocus={(event) => event.currentTarget.select()} className="workspace-preview-path" aria-label="文件路径" />
                </Tooltip>
                <span ref={pathMeasureRef} className="workspace-preview-path-measure" aria-hidden="true">{activeTab.title}</span>
              </div>
              <div ref={actionsRef} className="workspace-preview-file-actions">
              <IconActionButton label={copiedPath ? '路径已复制' : '复制文件路径'} variant="neutral" tooltip={!isMobile} onClick={() => onCopyPath(activeTab.sourcePath || activeTab.title)} className={isMobile ? 'h-10 w-10' : 'h-7 w-7'}>
                {copiedPath ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg> : <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M3 10V4.5A1.5 1.5 0 014.5 3H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
              </IconActionButton>
              <IconActionButton label="文件信息" variant="neutral" tooltip={!isMobile} onClick={() => setMobileInfo('file-info')} className={isMobile ? 'h-10 w-10' : 'h-7 w-7'}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-icon="file-metadata-info"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M8 7v4M8 4.8v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              </IconActionButton>
              <div ref={extraActionsRef} className={`workspace-preview-extra-actions${expandedActions?'':' is-measuring'}`} aria-hidden={!expandedActions} inert={!expandedActions}>
                {extraActions.map(action=><IconActionButton key={action.id} label={action.label} disabled={action.disabled} variant="neutral" tooltip={expandedActions&&!isMobile} onClick={()=>void action.onSelect()}>
                  {action.icon}
                </IconActionButton>)}
              </div>
              {!expandedActions&&<button ref={moreButtonRef} type="button" aria-label="更多文件操作" aria-haspopup="menu" aria-expanded={moreMenu?.tabId===activeTab.id} className={isMobile ? 'h-10 w-10 rounded-lg hover:bg-[var(--color-surface-hover)]' : 'h-7 w-7 rounded-lg hover:bg-[var(--color-surface-hover)]'} onClick={event=>setMoreMenu(moreMenu?null:{tabId:activeTab.id,rect:event.currentTarget.getBoundingClientRect()})}>⋯</button>}
              {!expandedActions&&moreMenu?.tabId===activeTab.id&&<ContextMenu open anchorRect={moreMenu.rect} mobile={isMobile} label="更多文件操作" onClose={()=>setMoreMenu(null)} items={extraActions} />}
              {activeTab.forceAccessAvailable ? (
                <div className="flex shrink-0 items-center gap-1">
                  {isMobile && (
                    <IconActionButton label="了解临时授权" variant="neutral" tooltip={false} className="h-10 w-10" onClick={() => setMobileInfo('force-access')}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-icon="file-access-info"><path d="M8 2.2l4.5 1.7v3.4c0 2.8-1.8 5.1-4.5 6.5-2.7-1.4-4.5-3.7-4.5-6.5V3.9L8 2.2z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><path d="M6.5 8l1 1 2-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </IconActionButton>
                  )}
                  <Tooltip disabled={isMobile} placement="bottom" content="权限仅适用于当前文件和本次打开，关闭标签后会撤销。">
                    <button type="button" onClick={() => onForceAccess(activeTab)} disabled={forceLoadingTabId === activeTab.id} className={`shrink-0 rounded px-2 text-xs text-[var(--color-status-warning)] transition-colors hover:bg-[var(--color-warning-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:opacity-50 ${isMobile ? 'min-h-10 py-2' : 'py-1'}`}>
                      {forceLoadingTabId === activeTab.id ? '授权中…' : '强制访问'}
                    </button>
                  </Tooltip>
                </div>
              ) : null}
              </div>
            </div>
            {previewModeControl}
            {updating && <div className="workspace-preview-git-status" role="status">正在更新预览…</div>}
            {!showGitDiff && gitDiffError?.tabId === activeTab.id && <div className="workspace-preview-git-status" role="status">Git 变更暂不可用<button type="button" onClick={() => onRefresh(activeTab)}>重试</button></div>}
            <div ref={htmlPreviewScrollRef} className="workspace-preview-viewport flex-1 min-h-0 overflow-auto"
              role={showingImage ? undefined : 'region'} aria-label={showingImage ? undefined : '文件内容'} tabIndex={showingImage ? undefined : 0}>
              {activeTab.textPreviewTruncated && !activeTab.previewError && <div className="workspace-preview-notice is-warning is-compact" role="status">文件 {formatFileMetadataSize(activeTab.contentSize ?? activeTab.fileMetadata?.size ?? NaN)}，{activeTab.textPreviewTruncationReason === 'output-size' ? '转换后的内容超过输出保护上限，请下载查看完整文件' : '超过当前预览容量'}；仅显示开头（最多 100 行 / 64 KB）。{activeTab.textPreviewTruncationReason !== 'output-size' && <button type="button" onClick={onOpenSettings}>调整预览容量</button>}</div>}
              {activeTab.previewError ? (
                <PreviewState
                  tone={activeTab.forceAccessAvailable ? 'warning' : 'danger'}
                  title="文件预览失败"
                  description={activeTab.previewError}
                  action={/上限|过大|预览容量/.test(activeTab.previewError) && onOpenSettings ? <button type="button" className="workspace-preview-state__button" onClick={onOpenSettings}>调整预览容量</button> : undefined}
                />
              ) : showGitDiff && gitDiffError?.tabId === activeTab.id ? (
                <PreviewState tone="danger" title="Git 变更不可用" description={gitDiffError.message} action={<button type="button" className="workspace-preview-state__button" onClick={() => onRefresh(activeTab)}>刷新重试</button>} />
              ) : showGitDiff && gitDiffResult?.tabId !== activeTab.id ? (
                <PreviewState tone="loading" title="正在读取 Git 变更" />
              ) : showGitDiff && gitDiff === null ? (
                <PreviewState title="相对 HEAD 没有变更" action={<button type="button" className="workspace-preview-state__button" onClick={() => onPreviewView(renderedPreview ? 'preview' : 'source')}>返回文件内容</button>} />
              ) : showGitDiff ? (
                <div className="py-2 font-mono text-xs leading-5">
                  <div className="workspace-preview-diff-caption">当前文件相对 HEAD 的变更</div>
                  {gitDiffLines.length > 4000 && <div className="workspace-preview-notice is-info">仅显示前 4000 行。</div>}
                  {gitDiffLines.slice(0, 4000).map((line, index) => {
                    const hunk = line[0] === '@';
                    return <div key={index} className={`git-diff-row ${line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : hunk ? 'hunk' : ''}`}>{hunk ? formatGitDiffHunkHeader(line, newFileDiff) : line}</div>;
                  })}
                </div>
              ) : activeTab.mediaPreview ? (
                <Suspense fallback={<PreviewState tone="loading" title="正在加载播放器" />}>
                  <MediaFilePreview key={activeTab.mediaPreview.previewUrl} media={activeTab.mediaPreview} title={getFileName(activeTab.title)} downloading={downloading} onDownload={() => onDownload(activeTab)} />
                </Suspense>
              ) : activeTab.documentPreview ? (
              <Suspense fallback={<PreviewState tone="loading" title="正在加载文档预览" />}>
                  {activeTab.documentPreview.type === 'pdf-document' ? (
                  <PdfDocumentPreview document={activeTab.documentPreview} downloading={downloading} onDownload={() => onDownload(activeTab)} />
                  ) : activeTab.documentPreview.type === 'word-document' ? (
                    <WordDocumentPreview document={activeTab.documentPreview} />
                  ) : activeTab.documentPreview.type === 'archive' ? (
                    <ArchivePreview key={activeTab.id} archive={activeTab.documentPreview} />
                  ) : (
                    <SpreadsheetPreview document={activeTab.documentPreview} sourcePath={activeTab.sourcePath || activeTab.title} accessToken={activeTab.fileAccessToken} requestSignal={requestSignal} />
                  )}
                </Suspense>
              ) : imageUrl ? (
                <ImageFilePreview key={activeTab.id} src={imageUrl} title={activeTab.title} />
              ) : activeTab.compressedPreviewAvailable ? (
                <PreviewState
                  tone="warning"
                  title="需要生成轻量预览"
                  description={activeTab.content}
                  action={<button type="button" disabled={compressingTabId === activeTab.id} onClick={() => onCompressedPreview(activeTab)} className="workspace-preview-state__button">
                      {compressingTabId === activeTab.id ? '压缩中…' : '压缩后预览'}
                  </button>}
                />
              ) : previewView === 'preview' && isMarkdownPreview(activeTab) ? (
                <Suspense fallback={<PreviewState tone="loading" title="正在排版 Markdown" />}>
                  <MarkdownFilePreview content={activeTab.content} sourcePath={activeTab.sourcePath || activeTab.title} />
                </Suspense>
              ) : sandboxedHtmlDocument ? (
                <div className="min-h-full bg-transparent">
                  {!activeTab.htmlPreviewScriptsEnabled && (
                    <div className="workspace-preview-notice is-warning">
                      <div><div className="font-medium text-[var(--color-text)]">普通 HTML 默认禁用脚本</div><div className="mt-0.5">静态内容可以直接查看；仅在确认文件可信时启用交互脚本。</div></div>
                      <button type="button" onClick={onRequestHtmlScripts} className="min-h-10 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">启用脚本</button>
                    </div>
                  )}
                  <iframe key={activeTab.id} ref={htmlIframeRef} className="block min-h-[20rem] w-full border-0 bg-transparent" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={sandboxedHtmlDocument} style={{ height: `${htmlPreviewHeight}px` }} aria-label={`HTML 可视化：${activeTab.title}`} />
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

      </div>
      <Modal open={settingsOpen && isMobile} onClose={() => onCloseSettings?.()} labelledBy="mobile-preview-settings-title" containerClassName="!items-end !p-0" contentClassName="preview-settings-mobile"><h2 id="mobile-preview-settings-title" className="sr-only">预览设置</h2>{settingsPanel}</Modal>
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
