import type { FileMetadataResult, FileReadResult } from '../../api/filesystem';
import { readFileMetadata, readPdfPreviewSource } from '../../api/filesystem';
import { ApiError } from '../../api/client';
import { assertMediaPreviewCapacity, downloadFile, readImagePreviewSource } from '../../api/filesystem';
import { compressImageForPreview } from '../../utils/image-preview';
import { getEffectivePreviewPreferences } from '../../stores/preview-preferences';
import type { RightPanelTab } from '../../stores/chat';

export type FilePreviewUpdate = Partial<Omit<RightPanelTab, 'id' | 'title'>>;

export const EMPTY_FILE_PREVIEW_MODES = {
  isImage: false,
  imageUrl: undefined,
  contentSize: undefined,
  textPreviewTruncated: undefined,
  textPreviewTruncationReason: undefined,
  language: undefined,
  documentPreview: undefined,
  mediaPreview: undefined,
  compressedPreviewAvailable: false,
  previewError: undefined,
} satisfies FilePreviewUpdate;

export function disposeFilePreviewUpdate(update: FilePreviewUpdate): void {
  if (update.documentPreview?.type === 'pdf-document') URL.revokeObjectURL(update.documentPreview.previewUrl);
  if (update.mediaPreview) URL.revokeObjectURL(update.mediaPreview.previewUrl);
}

export function getFilePreviewObjectUrl(update: FilePreviewUpdate): string | undefined {
  return update.mediaPreview?.previewUrl
    ?? (update.documentPreview?.type === 'pdf-document' ? update.documentPreview.previewUrl : undefined);
}

export async function buildFileMetadataUpdate(
  sourcePath: string,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<FilePreviewUpdate> {
  try {
    const fileMetadata: FileMetadataResult = await readFileMetadata(sourcePath, accessToken, { signal });
    signal?.throwIfAborted();
    return { fileMetadata, fileMetadataLoading: false, fileMetadataError: undefined };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      fileMetadata: undefined,
      fileMetadataLoading: false,
      fileMetadataError: {
        message: error instanceof Error && error.message.trim() ? error.message : '文件信息加载失败',
        ...(error instanceof ApiError ? { status: error.status, ...(error.data?.code ? { code: error.data.code } : {}) } : {}),
      },
    };
  }
}

export async function buildFilePreviewUpdate(
  data: FileReadResult,
  sourcePath: string,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<FilePreviewUpdate> {
  signal?.throwIfAborted();
  const common = {
    textPreviewTruncated: undefined,
    textPreviewTruncationReason: undefined,
    loading: false,
    forceAccessAvailable: false,
    compressedPreviewAvailable: false,
    documentPreview: undefined,
    mediaPreview: undefined,
    previewError: undefined,
  };
  if (data.type === 'media') {
    const blob = await downloadFile(sourcePath, accessToken, { signal });
    signal?.throwIfAborted();
    assertMediaPreviewCapacity(blob.size);
    return {
      ...common,
      content: '',
      contentSize: blob.size,
      language: undefined,
      isImage: false,
      imageUrl: undefined,
      mediaPreview: { kind: data.kind, previewUrl: URL.createObjectURL(blob.slice(0, blob.size, data.mimeType)) },
    };
  }
  if (data.type === 'image') {
    return { ...common, content: '', language: undefined, isImage: true, imageUrl: data.dataUrl };
  }
  if (data.type === 'image-preview-required') {
    try {
      const source = await readImagePreviewSource(sourcePath, accessToken, { signal });
      const imageUrl = await compressImageForPreview(source, signal, getEffectivePreviewPreferences().image);
      signal?.throwIfAborted();
      return { ...common, content: '', language: undefined, isImage: true, imageUrl };
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return {
      ...common,
      content: data.message || '图片较大，可压缩后预览',
      language: undefined,
      isImage: false,
      imageUrl: undefined,
      compressedPreviewAvailable: true,
    };
  }
  if (data.type === 'pdf-document') {
    const blob = await readPdfPreviewSource(sourcePath, accessToken, { signal });
    signal?.throwIfAborted();
    return {
      ...common,
      content: '',
      language: undefined,
      isImage: false,
      imageUrl: undefined,
      documentPreview: { ...data, previewUrl: URL.createObjectURL(blob) },
    };
  }
  if (data.type === 'word-document' || data.type === 'spreadsheet' || data.type === 'archive') {
    return {
      ...common,
      content: '',
      language: undefined,
      isImage: false,
      imageUrl: undefined,
      documentPreview: data,
    };
  }
  return {
    ...common,
    content: data.content,
    contentSize: data.size,
    textPreviewTruncated: data.truncated === true,
    textPreviewTruncationReason: data.truncated ? data.truncationReason : undefined,
    language: data.language,
    isImage: false,
    imageUrl: undefined,
  };
}
