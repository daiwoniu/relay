import { usePreviewPreferences, getEffectivePreviewPreferences } from '../../stores/preview-preferences';
import PreviewSettings from '../settings/PreviewSettings';
import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { localAction,featureAction } from '../../analytics/features';
import { tracker } from '../../analytics/tracker';
import type { RightPanelTab } from '../../stores/chat';
import { useChatStore } from '../../stores/chat';
import { authorizeFile, readFile, readImagePreviewSource, revokeFile } from '../../api/filesystem';
import ConfirmDialog from '../ui/ConfirmDialog';
import FailureNotice from '../ui/FailureNotice';
import Tooltip from '../ui/Tooltip';
import { useOverlay } from '../ui/OverlayProvider';
import { copyToClipboard } from '../../utils/clipboard';
import { compressImageForPreview } from '../../utils/image-preview';
import { buildFileMetadataUpdate, buildFilePreviewUpdate, disposeFilePreviewUpdate, getFilePreviewObjectUrl, EMPTY_FILE_PREVIEW_MODES } from './file-preview-state';
import { ApiError } from '../../api/client';
import { getFilePreviewView, type FilePreviewView } from './file-preview-view';
import { filePreviewRequestManager } from './file-preview-request-manager';
import { completePreviewOperation, currentPreviewOperationTab, type PreviewOperationState } from './preview-operation-state';
import { buildForceAccessFailureUpdate } from './file-preview-failure';
import { downloadPreviewFile } from './file-preview-download';
import { useTheme } from '../../hooks/useTheme';
import RightPanelContent, { getFileName } from './RightPanelContent';
import { shouldUseHtmlVisualization } from './file-preview-lines';
import { resolveCodexFileReferencePathResult } from '../messages/codex-file-directives';
import {
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  clampRightPanelWidth,
  getRightPanelWidthFromKey,
  storeRightPanelWidth,
} from '../../utils/right-panel-width';
import {
  buildSandboxedHtmlDocument,
  buildVisualizationThemeVariables,
  createHtmlPreviewNonce,
  HTML_PREVIEW_ANCHOR_MESSAGE,
  HTML_PREVIEW_HEIGHT_MESSAGE,
  type VisualizationThemeVariables,
} from './html-preview-document';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];

export function isImageFile(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby',
    php: 'php', swift: 'swift', kt: 'kotlin',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    html: 'html', htm: 'html', css: 'css', scss: 'scss',
    md: 'markdown', sh: 'bash', sql: 'sql',
    xml: 'xml', toml: 'toml', ini: 'ini',
  };
  return langMap[ext] || 'plaintext';
}

interface Props {
  tabs: RightPanelTab[];
  activeTabId: string | null;
  panelVisible: boolean;
  width: number;
  onClose: () => void;
  onCloseTab: (tabId: string) => void;
  onSelectTab: (id: string) => void;
}

export default function RightPanel({ tabs, activeTabId, panelVisible, width, onClose, onCloseTab, onSelectTab }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const preferencesRevision = usePreviewPreferences(s => s.revision);
  const preferencesLoaded = usePreviewPreferences(s => s.loaded);
  const preferencesUserId = usePreviewPreferences(s => s.userId);
  const previewVersions = useRef(new Map<string, string>());
  const [updatingTabs, setUpdatingTabs] = useState<Record<string, number>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const htmlIframeRef = useRef<HTMLIFrameElement>(null);
  const htmlPreviewScrollRef = useRef<HTMLDivElement>(null);
  const { effectiveTheme, appliedSettings, device } = useTheme();
  const setRightPanelWidth = useChatStore((s) => s.setRightPanelWidth);
  const hideRightPanel = useChatStore((s) => s.hideRightPanel);
  const rightPanelPinned = useChatStore((s) => s.rightPanelPinned);
  const toggleRightPanelPinned = useChatStore((s) => s.toggleRightPanelPinned);
  const closeAllRightPanelTabs = useChatStore((s) => s.closeAllRightPanelTabs);
  const updateRightPanelTab = useChatStore((s) => s.updateRightPanelTab);
  const { closeAllOverlays, closeOverlay, openOverlay } = useOverlay();
  const [isDragging, setIsDragging] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [forceOperations, setForceOperations] = useState<PreviewOperationState>({});
  const [compressOperations, setCompressOperations] = useState<PreviewOperationState>({});
  const downloadRequests = useRef(new Map<string, AbortController>());
  const [downloadStates, setDownloadStates] = useState<Record<string, { busy: boolean; error?: unknown }>>({});
  const cancelDownload = useCallback((tabId: string) => {
    downloadRequests.current.get(tabId)?.abort();
    downloadRequests.current.delete(tabId);
    setDownloadStates(state => {
      if (!(tabId in state)) return state;
      const next = { ...state }; delete next[tabId]; return next;
    });
  }, []);
  useEffect(() => {
    const ids = new Set(tabs.map(tab => tab.id));
    for (const id of downloadRequests.current.keys()) if (!ids.has(id)) cancelDownload(id);
    setDownloadStates(state => {
      const stale = Object.keys(state).filter(id => !ids.has(id));
      if (!stale.length) return state;
      const next = { ...state }; for (const id of stale) delete next[id]; return next;
    });
  }, [tabs, cancelDownload]);
  useEffect(() => () => {
    for (const request of downloadRequests.current.values()) request.abort();
    downloadRequests.current.clear();
  }, []);
  const requestIsCurrent = (tabId: string, generation: number) => filePreviewRequestManager.isCurrent(tabId, generation);
  const forceLoadingTabId = currentPreviewOperationTab(forceOperations, activeTabId, requestIsCurrent);
  const compressingTabId = currentPreviewOperationTab(compressOperations, activeTabId, requestIsCurrent);
  const [copiedPath, setCopiedPath] = useState(false);
  const [mobileInfo, setMobileInfo] = useState<'force-access' | 'file-info' | null>(null);
  const [htmlPreviewSize, setHtmlPreviewSize] = useState({ tabId: '', height: 320 });
  const htmlPreviewHeight = htmlPreviewSize.tabId === activeTabId ? htmlPreviewSize.height : 320;
  const [htmlScriptConfirmationOpen, setHtmlScriptConfirmationOpen] = useState(false);
  const [visualizationTheme, setVisualizationTheme] = useState<VisualizationThemeVariables>({});
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const panelWidthRef = useRef(width);

  // 移动端检测：< 1024px 时面板占满全屏
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024);
  useEffect(() => {
    if (!panelVisible) return;
    const onResize = () => setIsMobile(window.innerWidth < 1024);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [panelVisible]);

  const isOpen = panelVisible;
  const effectiveWidth = isOpen ? (isMobile || isMaximized ? '100%' : `${width + (settingsOpen ? 290 : 0)}px`) : '0px';
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const downloadError = activeTab ? downloadStates[activeTab.id]?.error : undefined;
  const dismissDownloadFailure = useCallback(() => {
    if (!activeTabId) return;
    setDownloadStates(state => {
      if (!state[activeTabId]?.error) return state;
      return { ...state, [activeTabId]: { ...state[activeTabId], error: undefined } };
    });
  }, [activeTabId]);
  const isHtmlPreview = activeTab?.language === 'html' || activeTab?.language === 'htm';
  const htmlVisualizationEnabled = Boolean(
    isHtmlPreview && activeTab && getFilePreviewView(activeTab) === 'preview' && shouldUseHtmlVisualization(activeTab.contentSize, 'visualization'),
  );

  useEffect(() => {
    panelWidthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!panelVisible) {
      setIsMaximized(false);
      setSettingsOpen(false);
    }
  }, [panelVisible]);

  useEffect(() => {
    setMobileInfo(null);
    setHtmlScriptConfirmationOpen(false);
  }, [activeTabId, panelVisible]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const updateTheme = () => {
      const style = window.getComputedStyle(root);
      setVisualizationTheme(buildVisualizationThemeVariables((name) => style.getPropertyValue(name)));
    };
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-style', 'data-text-scale', 'data-advanced-theme', 'style'] });
    return () => observer.disconnect();
  }, [appliedSettings, device, effectiveTheme]);

  useEffect(() => {
    const handlePreviewMessage = (event: MessageEvent) => {
      if (event.source !== htmlIframeRef.current?.contentWindow) return;
      if (!event.data) return;
      if (event.data.type === HTML_PREVIEW_HEIGHT_MESSAGE) {
        const height = Number(event.data.height);
        if (!Number.isFinite(height)) return;
        setHtmlPreviewSize({ tabId: activeTabId ?? '', height: Math.min(20_000, Math.max(320, Math.ceil(height))) });
        return;
      }
      if (event.data.type !== HTML_PREVIEW_ANCHOR_MESSAGE) return;
      const top = Number(event.data.top);
      const scrollContainer = htmlPreviewScrollRef.current;
      const iframe = htmlIframeRef.current;
      if (!Number.isFinite(top) || !scrollContainer || !iframe) return;
      const iframeTop = iframe.getBoundingClientRect().top
        - scrollContainer.getBoundingClientRect().top
        + scrollContainer.scrollTop;
      scrollContainer.scrollTo({ top: Math.max(0, iframeTop + top), behavior: 'smooth' });
    };
    window.addEventListener('message', handlePreviewMessage);
    return () => window.removeEventListener('message', handlePreviewMessage);
  }, [activeTabId]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isOpen || downloadError) return;
      if (settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      if (isMaximized) {
        setIsMaximized(false);
        return;
      }
      hideRightPanel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [hideRightPanel, isMaximized, isOpen, downloadError, settingsOpen]);

  // 拖拽调整宽度
  const handleDragStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    closeAllOverlays();
    event.currentTarget.focus({ preventScroll: true });
    openOverlay('dragging', 'right-panel-resize');
    setIsDragging(true);
    dragStartX.current = event.clientX;
    dragStartWidth.current = width;
  }, [closeAllOverlays, openOverlay, width]);

  const updatePanelWidth = useCallback((nextWidth: number, persist = false) => {
    const clampedWidth = clampRightPanelWidth(nextWidth);
    panelWidthRef.current = clampedWidth;
    setRightPanelWidth(clampedWidth);
    if (persist) storeRightPanelWidth(clampedWidth);
  }, [setRightPanelWidth]);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent) => {
    const nextWidth = getRightPanelWidthFromKey(width, event.key);
    if (nextWidth === null) return;
    event.preventDefault();
    if(nextWidth!==width)featureAction('file_preview','resize','keyboard');
    updatePanelWidth(nextWidth, true);
  }, [updatePanelWidth, width]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = dragStartX.current - e.clientX;
      updatePanelWidth(dragStartWidth.current + delta);
    };
    const handleMouseUp = () => {
      if(panelWidthRef.current!==dragStartWidth.current)featureAction('file_preview','resize','preview_toolbar');
      storeRightPanelWidth(panelWidthRef.current);
      setIsDragging(false);
      closeOverlay('dragging', 'right-panel-resize');
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      closeOverlay('dragging', 'right-panel-resize');
    };
  }, [closeOverlay, isDragging, updatePanelWidth]);


  const sandboxedHtmlDocument = useMemo(() => (
    isOpen && htmlVisualizationEnabled && activeTab ? buildSandboxedHtmlDocument(activeTab.content, visualizationTheme, {
      nonce: createHtmlPreviewNonce(),
      allowUserScripts: activeTab.htmlPreviewScriptsEnabled === true,
    }) : ''
  ), [activeTab?.id, activeTab?.content, activeTab?.htmlPreviewScriptsEnabled, htmlVisualizationEnabled, isOpen, visualizationTheme]);

  const handlePreviewView = useCallback((mode: FilePreviewView) => {
    if (!activeTab) return;
    if(activeTab.previewView!==mode)tracker.action({feature:'file_preview',action:'mode',surface:'preview_toolbar',mode:mode==='git-diff'?'git_diff':mode==='preview'?'rendered':'source'});
    updateRightPanelTab(activeTab.id, {
      previewView: mode,
      ...(isHtmlPreview && mode !== 'git-diff' ? { htmlPreviewMode: mode === 'preview' ? 'visualization' as const : 'source' as const } : {}),
    });
  }, [activeTab, isHtmlPreview, updateRightPanelTab]);

  const handleRefresh = useCallback(async (tab: RightPanelTab, preserve = false) => {
    const report=preserve?()=>false:tracker.captureResult({feature:'file_preview',action:'refresh',surface:'preview_toolbar'});
    cancelDownload(tab.id);
    const sourcePath = tab.sourcePath || tab.title;
    // Tabs must retain their original absolute path, even after switching projects.
    const resolution = resolveCodexFileReferencePathResult(sourcePath);
    if (!resolution.ok) {
      report('error');
      updateRightPanelTab(tab.id, {
        loading: false, previewError: resolution.reason,
        fileMetadataLoading: false, fileMetadataError: resolution.reason,
      });
      return;
    }
    if (!preserve) setHtmlPreviewSize({ tabId: tab.id, height: 320 });
    const request = filePreviewRequestManager.begin(tab.id, { retainAccessToken: true, retainObjectUrls: preserve });
    if (preserve) setUpdatingTabs(state => ({ ...state, [tab.id]: request.generation }));
    if (tab.fileAccessToken) filePreviewRequestManager.trackAccessToken(tab.id, request.generation, tab.fileAccessToken);
    if (!preserve) updateRightPanelTab(tab.id, { ...EMPTY_FILE_PREVIEW_MODES, loading: true, fileMetadataLoading: true });
    void buildFileMetadataUpdate(sourcePath, tab.fileAccessToken, request.signal).then((update) => {
      if (filePreviewRequestManager.isCurrent(tab.id, request.generation)) updateRightPanelTab(tab.id, update);
    }).catch(() => undefined);
    try {
      const data = await readFile(sourcePath, tab.fileAccessToken, { signal: request.signal });
      const update = await buildFilePreviewUpdate(data, sourcePath, tab.fileAccessToken, request.signal);
      if (!filePreviewRequestManager.isCurrent(tab.id, request.generation) || !updateRightPanelTab(tab.id, update)) {
        disposeFilePreviewUpdate(update);
        return;
      }
      filePreviewRequestManager.replaceObjectUrls(tab.id, request.generation, getFilePreviewObjectUrl(update));
      report(update.previewError?'error':'success');
    } catch (error) {
      report(request.signal.aborted?'cancelled':'error');
      if (!filePreviewRequestManager.isCurrent(tab.id, request.generation)) return;
      const message = error instanceof ApiError ? error.data?.error || '刷新文件失败' : '刷新文件失败，请重试';
      filePreviewRequestManager.replaceObjectUrls(tab.id, request.generation);
      updateRightPanelTab(tab.id, {
        ...EMPTY_FILE_PREVIEW_MODES, loading: false, content: message, previewError: message,
        forceAccessAvailable: error instanceof ApiError && error.status === 403 && error.data?.code === 'PATH_NOT_ALLOWED' && error.data?.canForceAccess === true,
      });
    }
    finally { if (preserve) setUpdatingTabs(state => completePreviewOperation(state, tab.id, request.generation)); }
  }, [updateRightPanelTab, cancelDownload]);

  useEffect(() => {
    if (!isOpen || !activeTab) return;
    const version = preferencesUserId + ':' + preferencesRevision;
    const previous = previewVersions.current.get(activeTab.id);
    if (!preferencesLoaded) {
      if (previous === undefined) previewVersions.current.set(activeTab.id, version);
      return;
    }
    previewVersions.current.set(activeTab.id, version);
    if (previous !== undefined && previous !== version) void handleRefresh(activeTab, true);
  }, [isOpen, activeTabId, preferencesUserId, preferencesLoaded, preferencesRevision, handleRefresh]);
  useEffect(() => {
    const ids = new Set(tabs.map(tab => tab.id));
    for (const id of previewVersions.current.keys()) if (!ids.has(id)) previewVersions.current.delete(id);
  }, [tabs]);

  const enableHtmlScripts = useCallback(() => {
    if (!activeTab || !isHtmlPreview) return;
    tracker.action({feature:'file_preview',action:'enable_scripts',surface:'preview_toolbar'});
    updateRightPanelTab(activeTab.id, { htmlPreviewScriptsEnabled: true });
    setHtmlScriptConfirmationOpen(false);
  }, [activeTab, isHtmlPreview, updateRightPanelTab]);

  const handleDownload = useCallback(async (tab: RightPanelTab) => {
    if (downloadRequests.current.has(tab.id) || !useChatStore.getState().rightPanelTabs.some(item => item.id === tab.id)) return;
    const request = new AbortController();
    const reportDownload=localAction('file_preview','download','preview_toolbar');
    downloadRequests.current.set(tab.id, request);
    const previewSignal = filePreviewRequestManager.getSignal(tab.id);
    const onPreviewReplaced = () => cancelDownload(tab.id);
    if (previewSignal?.aborted) { cancelDownload(tab.id); return; }
    previewSignal?.addEventListener('abort', onPreviewReplaced, { once: true });
    const current = () => downloadRequests.current.get(tab.id) === request
      && !request.signal.aborted && useChatStore.getState().rightPanelTabs.some(item => item.id === tab.id);
    setDownloadStates(state => ({ ...state, [tab.id]: { busy: true } }));
    try {
      await downloadPreviewFile(tab, request.signal, current);
      reportDownload(true);
    } catch (error) {
      reportDownload(false);
      if (current()) setDownloadStates(state => ({ ...state, [tab.id]: { busy: false, error } }));
    } finally {
      previewSignal?.removeEventListener('abort', onPreviewReplaced);
      if (downloadRequests.current.get(tab.id) === request) {
        downloadRequests.current.delete(tab.id);
        setDownloadStates(state => ({ ...state, [tab.id]: { ...state[tab.id], busy: false } }));
      }
    }
  }, [cancelDownload]);

  const handleCloseTab = useCallback((tab: RightPanelTab) => {
    cancelDownload(tab.id);
    setForceOperations((state) => completePreviewOperation(state, tab.id));
    setCompressOperations((state) => completePreviewOperation(state, tab.id));
    onCloseTab(tab.id);
  }, [onCloseTab, cancelDownload]);

  const handleCloseAllTabs = useCallback(() => {
    for (const id of downloadRequests.current.keys()) cancelDownload(id);
    setForceOperations({});
    setCompressOperations({});
    closeAllRightPanelTabs();
  }, [closeAllRightPanelTabs, cancelDownload]);

  const handleForceAccess = useCallback(async (tab: RightPanelTab) => {
    const sourcePath = tab.sourcePath || tab.title;
    const request = filePreviewRequestManager.begin(tab.id);
    let authorizedAccessToken: string | undefined;
    setForceOperations((state) => ({ ...state, [tab.id]: request.generation }));
    try {
      const authorization = await authorizeFile(sourcePath, { signal: request.signal });
      if (!filePreviewRequestManager.trackAccessToken(tab.id, request.generation, authorization.accessToken)) {
        void revokeFile(authorization.accessToken).catch(() => undefined);
        return;
      }
      authorizedAccessToken = authorization.accessToken;
      updateRightPanelTab(tab.id, { fileMetadataLoading: true, fileMetadataError: undefined });
      void buildFileMetadataUpdate(sourcePath, authorization.accessToken, request.signal).then((metadataUpdate) => {
        if (filePreviewRequestManager.isCurrent(tab.id, request.generation)) {
          updateRightPanelTab(tab.id, metadataUpdate);
        }
      }).catch(() => undefined);
      const data = await readFile(sourcePath, authorization.accessToken, { signal: request.signal });
      const update = {
        ...(await buildFilePreviewUpdate(data, sourcePath, authorization.accessToken, request.signal)),
        fileAccessToken: authorization.accessToken,
      };
      if (!filePreviewRequestManager.isCurrent(tab.id, request.generation)
        || !updateRightPanelTab(tab.id, update)) {
        disposeFilePreviewUpdate(update);
        return;
      }
      const objectUrl = getFilePreviewObjectUrl(update);
      if (objectUrl) {
        filePreviewRequestManager.trackObjectUrl(tab.id, request.generation, objectUrl);
      }
    } catch (err) {
      if (request.signal.aborted || !filePreviewRequestManager.isCurrent(tab.id, request.generation)) return;
      updateRightPanelTab(tab.id, buildForceAccessFailureUpdate(err, authorizedAccessToken));
    } finally {
      setForceOperations((state) => completePreviewOperation(state, tab.id, request.generation));
    }
  }, [updateRightPanelTab]);

  const handleCompressedPreview = useCallback(async (tab: RightPanelTab) => {
    const request = filePreviewRequestManager.begin(tab.id, { retainAccessToken: true });
    if (tab.fileAccessToken && !filePreviewRequestManager.trackAccessToken(tab.id, request.generation, tab.fileAccessToken)) return;
    setCompressOperations((state) => ({ ...state, [tab.id]: request.generation }));
    try {
      const source = await readImagePreviewSource(tab.sourcePath || tab.title, tab.fileAccessToken, { signal: request.signal });
      const imageUrl = await compressImageForPreview(source, request.signal, getEffectivePreviewPreferences().image);
      if (!filePreviewRequestManager.isCurrent(tab.id, request.generation)) return;
      updateRightPanelTab(tab.id, {
        content: '',
        isImage: true,
        imageUrl,
        loading: false,
        compressedPreviewAvailable: false,
      });
    } catch (error) {
      if (request.signal.aborted || !filePreviewRequestManager.isCurrent(tab.id, request.generation)) return;
      updateRightPanelTab(tab.id, {
        content: `压缩预览失败：${error instanceof Error ? error.message : '未知错误'}`,
        isImage: false,
        imageUrl: undefined,
        compressedPreviewAvailable: true,
      });
    } finally {
      setCompressOperations((state) => completePreviewOperation(state, tab.id, request.generation));
    }
  }, [updateRightPanelTab]);

  const handleCopyPath = useCallback(async (filePath: string) => {
    const reportCopy=localAction('file_preview','copy_path','preview_toolbar');
    try {
      await copyToClipboard(filePath);
      reportCopy(true);
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1500);
    } catch {
      reportCopy(false);
      setCopiedPath(false);
    }
  }, []);

  return (
    <>
      {/* Overlay for mobile */}
      {isOpen && (
        <div className={`workspace-preview-backdrop${rightPanelPinned ? ' is-pinned' : ''}`} onClick={rightPanelPinned ? undefined : hideRightPanel} />
      )}

      <aside
        ref={panelRef}
        data-right-panel
        aria-label="文件预览"
        aria-hidden={!isOpen}
        inert={!isOpen}
        className={`workspace-preview-panel theme-surface${isOpen ? ' is-open' : ''}${isMobile ? ' is-mobile' : ''}${isMaximized ? ' is-maximized' : ''}${isDragging ? ' is-resizing' : ''}`}
        style={{ width: effectiveWidth }}
      >
        {/* 拖拽手柄 —— 左边框 */}
        {isOpen && !isMobile && !isMaximized && (
          <Tooltip content="拖动调整预览宽度" placement="right" className="workspace-preview-resizer-wrap">
            <div
              className="workspace-preview-resizer"
              onMouseDown={handleDragStart}
              onKeyDown={handleResizeKeyDown}
              role="separator"
              tabIndex={0}
              aria-label="拖动调整预览宽度"
              aria-orientation="vertical"
              aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
              aria-valuemax={RIGHT_PANEL_MAX_WIDTH}
              aria-valuenow={width}
            >
              <div className="workspace-preview-resizer__grip" />
            </div>
          </Tooltip>
        )}

        <RightPanelContent
          settingsOpen={settingsOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onCloseSettings={() => setSettingsOpen(false)}
          settingsPanel={settingsOpen ? <PreviewSettings surface="preview_toolbar" onClose={() => setSettingsOpen(false)} /> : undefined}
          updating={Boolean(activeTab && updatingTabs[activeTab.id])}
          tabs={tabs}
          activeTab={isOpen ? activeTab : undefined}
          activeTabId={activeTabId}
          isMobile={isMobile}
          isMaximized={isMaximized}
          rightPanelPinned={rightPanelPinned}
          copiedPath={copiedPath}
          mobileInfo={mobileInfo}
          forceLoadingTabId={forceLoadingTabId}
          compressingTabId={compressingTabId}
          downloading={Boolean(activeTab && downloadStates[activeTab.id]?.busy)}
          isHtmlPreview={isHtmlPreview}
          sandboxedHtmlDocument={sandboxedHtmlDocument}
          htmlPreviewHeight={htmlPreviewHeight}
          htmlIframeRef={htmlIframeRef}
          htmlPreviewScrollRef={htmlPreviewScrollRef}
          requestSignal={activeTab ? filePreviewRequestManager.getSignal(activeTab.id) : undefined}
          onSelectTab={onSelectTab}
          onCloseTab={handleCloseTab}
          onHidePanel={hideRightPanel}
          onTogglePinned={toggleRightPanelPinned}
          setIsMaximized={setIsMaximized}
          onCloseAllTabs={handleCloseAllTabs}
          onCopyPath={(filePath) => void handleCopyPath(filePath)}
          onForceAccess={(tab) => void handleForceAccess(tab)}
          onDownload={(tab) => void handleDownload(tab)}
          onCompressedPreview={(tab) => void handleCompressedPreview(tab)}
          onPreviewView={handlePreviewView}
          onRefresh={(tab) => void handleRefresh(tab)}
          onRequestHtmlScripts={() => {featureAction('file_preview','request_scripts','preview_toolbar');setHtmlScriptConfirmationOpen(true);}}
          setMobileInfo={(info) => {if(info==='file-info'&&mobileInfo!==info)featureAction('file_preview','details','preview_toolbar');setMobileInfo(info);}}
        />

      </aside>


      <ConfirmDialog
        open={Boolean(downloadError)}
        eyebrow="下载提示"
        title="文件下载失败"
        description={<FailureNotice error={downloadError} />}
        subject={activeTab ? { label: '文件', value: getFileName(activeTab.title) } : undefined}
        cancelLabel={null}
        confirmLabel="知道了"
        onConfirm={dismissDownloadFailure}
        onCancel={dismissDownloadFailure}
        tone="danger"
      />

      <ConfirmDialog
        open={htmlScriptConfirmationOpen}
        title="确认启用 HTML 脚本"
        description="脚本可能修改预览内容或访问白名单中的网络资源。只应为你信任的文件启用。"
        subject={activeTab ? { label: '当前文件', value: getFileName(activeTab.title), detail: activeTab.title } : undefined}
        impacts={['仅对当前文件标签生效', '关闭标签后自动撤销授权', '预览仍在无同源权限的隔离 iframe 中运行']}
        notice={{ tone: 'warning', title: '安全提示', description: '来源不明的 HTML 请保持脚本禁用。' }}
        confirmLabel="启用脚本"
        onConfirm={enableHtmlScripts}
        onCancel={() => {featureAction('file_preview','cancel_scripts','preview_toolbar');setHtmlScriptConfirmationOpen(false);}}
        tone="warning"
      />
    </>
  );
}
