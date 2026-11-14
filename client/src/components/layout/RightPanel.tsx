import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import type { HtmlPreviewMode, RightPanelTab } from '../../stores/chat';
import { useChatStore } from '../../stores/chat';
import { authorizeFile, readFile, readImagePreviewSource, revokeFile } from '../../api/filesystem';
import ConfirmDialog from '../ui/ConfirmDialog';
import Tooltip from '../ui/Tooltip';
import { useOverlay } from '../ui/OverlayProvider';
import { copyToClipboard } from '../../utils/clipboard';
import { compressImageForPreview } from '../../utils/image-preview';
import { buildFileMetadataUpdate, buildFilePreviewUpdate, disposeFilePreviewUpdate } from './file-preview-state';
import { filePreviewRequestManager } from './file-preview-request-manager';
import { buildForceAccessFailureUpdate } from './file-preview-failure';
import { useTheme } from '../../hooks/useTheme';
import RightPanelContent, { getFileName } from './RightPanelContent';
import { shouldUseHtmlVisualization } from './file-preview-lines';
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
  const [forceLoadingTabId, setForceLoadingTabId] = useState<string | null>(null);
  const [compressingTabId, setCompressingTabId] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [mobileInfo, setMobileInfo] = useState<'force-access' | 'file-info' | null>(null);
  const [htmlPreviewHeight, setHtmlPreviewHeight] = useState(320);
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
  const effectiveWidth = isOpen ? (isMobile || isMaximized ? '100%' : `${width}px`) : '0px';
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isHtmlPreview = activeTab?.language === 'html' || activeTab?.language === 'htm';
  const htmlVisualizationEnabled = Boolean(
    isHtmlPreview && activeTab && shouldUseHtmlVisualization(activeTab.contentSize, activeTab.htmlPreviewMode),
  );

  useEffect(() => {
    panelWidthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!panelVisible) setIsMaximized(false);
  }, [panelVisible]);

  useEffect(() => {
    setMobileInfo(null);
    setHtmlScriptConfirmationOpen(false);
  }, [activeTabId, panelVisible]);

  useEffect(() => {
    setHtmlPreviewHeight(320);
  }, [activeTabId]);

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
        setHtmlPreviewHeight(Math.min(20_000, Math.max(320, Math.ceil(height))));
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
  }, []);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isOpen) return;
      if (isMaximized) {
        setIsMaximized(false);
        return;
      }
      hideRightPanel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [hideRightPanel, isMaximized, isOpen]);

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
    updatePanelWidth(nextWidth, true);
  }, [updatePanelWidth, width]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = dragStartX.current - e.clientX;
      updatePanelWidth(dragStartWidth.current + delta);
    };
    const handleMouseUp = () => {
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
  ), [activeTab, htmlVisualizationEnabled, isOpen, visualizationTheme]);

  const handleHtmlPreviewMode = useCallback((mode: HtmlPreviewMode) => {
    if (!activeTab || !isHtmlPreview) return;
    if (mode === 'visualization' && !shouldUseHtmlVisualization(activeTab.contentSize, mode)) return;
    updateRightPanelTab(activeTab.id, { htmlPreviewMode: mode });
  }, [activeTab, isHtmlPreview, updateRightPanelTab]);


  const enableHtmlScripts = useCallback(() => {
    if (!activeTab || !isHtmlPreview) return;
    updateRightPanelTab(activeTab.id, { htmlPreviewScriptsEnabled: true });
    setHtmlScriptConfirmationOpen(false);
  }, [activeTab, isHtmlPreview, updateRightPanelTab]);

  // 下载文件
  const handleDownload = useCallback((tab: RightPanelTab) => {
    const fileName = tab.title.split(/[\\/]/).pop() || tab.title;
    const isAbsolutePath = /^[A-Za-z]:[\\/]/.test(tab.title) || tab.title.startsWith('/') || tab.title.startsWith('~/');
    if (isAbsolutePath) {
      const query = new URLSearchParams({ path: tab.sourcePath || tab.title });
      if (tab.fileAccessToken) query.set('accessToken', tab.fileAccessToken);
      const a = document.createElement('a');
      a.href = `/api/filesystem/download?${query.toString()}`;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } else if (tab.isImage && tab.imageUrl) {
      // 图片：直接用 data URL 下载
      const a = document.createElement('a');
      a.href = tab.imageUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } else {
      // 文本：创建 blob 下载
      const blob = new Blob([tab.content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }, []);

  const handleCloseTab = useCallback((tab: RightPanelTab) => {
    onCloseTab(tab.id);
  }, [onCloseTab]);

  const handleCloseAllTabs = useCallback(() => {
    closeAllRightPanelTabs();
  }, [closeAllRightPanelTabs]);

  const handleForceAccess = useCallback(async (tab: RightPanelTab) => {
    const sourcePath = tab.sourcePath || tab.title;
    const request = filePreviewRequestManager.begin(tab.id);
    let authorizedAccessToken: string | undefined;
    setForceLoadingTabId(tab.id);
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
      if (update.documentPreview?.type === 'pdf-document') {
        filePreviewRequestManager.trackObjectUrl(tab.id, request.generation, update.documentPreview.previewUrl);
      }
    } catch (err) {
      if (request.signal.aborted || !filePreviewRequestManager.isCurrent(tab.id, request.generation)) return;
      updateRightPanelTab(tab.id, buildForceAccessFailureUpdate(err, authorizedAccessToken));
    } finally {
      if (filePreviewRequestManager.isCurrent(tab.id, request.generation)) setForceLoadingTabId(null);
    }
  }, [updateRightPanelTab]);

  const handleCompressedPreview = useCallback(async (tab: RightPanelTab) => {
    const request = filePreviewRequestManager.begin(tab.id, { retainAccessToken: true });
    if (tab.fileAccessToken && !filePreviewRequestManager.trackAccessToken(tab.id, request.generation, tab.fileAccessToken)) return;
    setCompressingTabId(tab.id);
    try {
      const source = await readImagePreviewSource(tab.sourcePath || tab.title, tab.fileAccessToken, { signal: request.signal });
      const imageUrl = await compressImageForPreview(source, request.signal);
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
      if (filePreviewRequestManager.isCurrent(tab.id, request.generation)) setCompressingTabId(null);
    }
  }, [updateRightPanelTab]);

  const handleCopyPath = useCallback(async (filePath: string) => {
    try {
      await copyToClipboard(filePath);
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1500);
    } catch {
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
          onDownload={handleDownload}
          onCompressedPreview={(tab) => void handleCompressedPreview(tab)}
          onHtmlPreviewMode={handleHtmlPreviewMode}
          onRequestHtmlScripts={() => setHtmlScriptConfirmationOpen(true)}
          setMobileInfo={setMobileInfo}
        />

      </aside>


      <ConfirmDialog
        open={htmlScriptConfirmationOpen}
        title="确认启用 HTML 脚本"
        description="脚本可能修改预览内容或访问白名单中的网络资源。只应为你信任的文件启用。"
        subject={activeTab ? { label: '当前文件', value: getFileName(activeTab.title), detail: activeTab.title } : undefined}
        impacts={['仅对当前文件标签生效', '关闭标签后自动撤销授权', '预览仍在无同源权限的隔离 iframe 中运行']}
        notice={{ tone: 'warning', title: '安全提示', description: '来源不明的 HTML 请保持脚本禁用。' }}
        confirmLabel="启用脚本"
        onConfirm={enableHtmlScripts}
        onCancel={() => setHtmlScriptConfirmationOpen(false)}
        tone="warning"
      />
    </>
  );
}
