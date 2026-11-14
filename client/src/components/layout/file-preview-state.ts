import type { FileMetadataResult, FileReadResult } from '../../api/filesystem';
import { readFileMetadata, readPdfPreviewSource } from '../../api/filesystem';
import type { RightPanelTab } from '../../stores/chat';

export type FilePreviewUpdate = Partial<Omit<RightPanelTab, 'id' | 'title'>>;

export const EMPTY_FILE_PREVIEW_MODES = {
  isImage: false,
  imageUrl: undefined,
  contentSize: undefined,
  textPreviewTruncated: undefined,
  language: undefined,
  documentPreview: undefined,
  compressedPreviewAvailable: false,
  previewError: undefined,
} satisfies FilePreviewUpdate;

export function disposeFilePreviewUpdate(update: FilePreviewUpdate): void {
  if (update.documentPreview?.type === 'pdf-document') URL.revokeObjectURL(update.documentPreview.previewUrl);
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
    return { fileMetadata: undefined, fileMetadataLoading: false, fileMetadataError: '文件信息加载失败' };
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
    loading: false,
    forceAccessAvailable: false,
    compressedPreviewAvailable: false,
    documentPreview: undefined,
    previewError: undefined,
  };
  if (data.type === 'image') {
    return { ...common, content: '', language: undefined, isImage: true, imageUrl: data.dataUrl };
  }
  if (data.type === 'image-preview-required') {
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
  if (data.type === 'word-document' || data.type === 'spreadsheet') {
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
    language: data.language,
    isImage: false,
    imageUrl: undefined,
  };
}
