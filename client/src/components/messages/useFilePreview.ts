import { useCallback } from 'react';
import {tracker} from '../../analytics/tracker';
import { ApiError } from '../../api/client';
import { readFile } from '../../api/filesystem';
import { useChatStore } from '../../stores/chat';
import { buildFileMetadataUpdate, buildFilePreviewUpdate, disposeFilePreviewUpdate, getFilePreviewObjectUrl, EMPTY_FILE_PREVIEW_MODES } from '../layout/file-preview-state';
import { filePreviewRequestManager } from '../layout/file-preview-request-manager';
import type { HtmlPreviewMode } from '../../stores/chat';

interface FilePreviewOptions {
  preferredMode?: HtmlPreviewMode;
  allowHtmlScripts?: boolean;
}

function isHtmlFilePath(filePath: string): boolean {
  return /\.html?$/i.test(filePath.split(/[?#]/, 1)[0]);
}

export function useFilePreview() {
  const openRightPanel = useChatStore((state) => state.openRightPanel);
  const updateRightPanelTab = useChatStore((state) => state.updateRightPanelTab);

  return useCallback(async (filePath: string, options: FilePreviewOptions = {}) => {
    const preferredMode = options.preferredMode ?? 'source';
    const existing = useChatStore.getState().rightPanelTabs.find((tab) => tab.title === filePath);
    const tabId = openRightPanel({
      title: filePath,
      sourcePath: filePath,
      content: '',
      loading: true,
      forceAccessAvailable: false,
      fileAccessToken: undefined,
      fileMetadata: undefined,
      fileMetadataLoading: true,
      fileMetadataError: undefined,
      htmlPreviewMode: isHtmlFilePath(filePath)
        ? existing?.htmlPreviewMode ?? preferredMode
        : undefined,
      htmlPreviewScriptsEnabled: isHtmlFilePath(filePath)
        ? existing?.htmlPreviewScriptsEnabled ?? options.allowHtmlScripts === true
        : undefined,
      ...EMPTY_FILE_PREVIEW_MODES,
    });
    const request = filePreviewRequestManager.begin(tabId);
    const report=tracker.captureResult({feature:'file_preview',action:'load',surface:'message_file'});
    void buildFileMetadataUpdate(filePath, undefined, request.signal).then((metadataUpdate) => {
      if (filePreviewRequestManager.isCurrent(tabId, request.generation)) {
        updateRightPanelTab(tabId, metadataUpdate);
      }
    }).catch(() => undefined);
    try {
      const data = await readFile(filePath, undefined, { signal: request.signal });
      const update = await buildFilePreviewUpdate(data, filePath, undefined, request.signal);
      if (!filePreviewRequestManager.isCurrent(tabId, request.generation)
        || !updateRightPanelTab(tabId, update)) {
        disposeFilePreviewUpdate(update);
        report('cancelled');
        return;
      }
      const objectUrl = getFilePreviewObjectUrl(update);
      report(update.previewError?'error':'success');
      if (objectUrl) {
        filePreviewRequestManager.trackObjectUrl(tabId, request.generation, objectUrl);
      }
    } catch (error) {
      if (request.signal.aborted || !filePreviewRequestManager.isCurrent(tabId, request.generation)){report('cancelled');return;}
      report('error',{reasonCode:'LOAD_FAILED'});
      if (error instanceof ApiError) {
        const errorMessage = error.data?.error || '读取文件失败';
        updateRightPanelTab(tabId, {
          ...EMPTY_FILE_PREVIEW_MODES,
          content: errorMessage,
          previewError: errorMessage,
          loading: false,
          sourcePath: filePath,
          forceAccessAvailable: error.status === 403
            && error.data?.code === 'PATH_NOT_ALLOWED'
            && error.data?.canForceAccess === true,
          fileAccessToken: undefined,
          compressedPreviewAvailable: false,
        });
      } else {
        const errorMessage = `读取文件失败: ${error instanceof Error ? error.message : '未知错误'}`;
        updateRightPanelTab(tabId, {
          ...EMPTY_FILE_PREVIEW_MODES,
          content: errorMessage,
          previewError: errorMessage,
          loading: false,
          sourcePath: filePath,
          forceAccessAvailable: false,
          fileAccessToken: undefined,
        });
      }
    }
  }, [openRightPanel, updateRightPanelTab]);
}
