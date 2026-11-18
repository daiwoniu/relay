import { ApiError, jsonBody, requestBlob, requestJson } from './client';
import { getMediaFileType, type MediaFileType } from '../utils/media-file';
import { getEffectivePreviewPreferences } from '../stores/preview-preferences';
import type {
  ArchivePreviewDto,
  FileAccessResponseDto,
  HostFileAuthorizationResponseDto,
  OkDto,
  PdfDocumentPreviewDto,
  SpreadsheetDocumentPreviewDto,
  SpreadsheetSheetResponseDto,
  WordDocumentPreviewDto,
} from '../generated/relay-contracts';

export interface DirectoryEntry {
  name: string;
  path: string;
  modifiedAt: number | null;
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

export interface HostFileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  size: number | null;
  modifiedAt?: number | null;
}

export interface HostFileBrowseResult {
  current: string;
  parent: string | null;
  entries: HostFileEntry[];
}

export interface CreateDirectoryResult {
  path: string;
}

export type FileReadResult =
  | ({ type: 'media'; size: number } & MediaFileType)
  | { type: 'text'; content: string; language: string; size: number; truncated?: boolean; truncationReason?: 'file-size' | 'output-size' }
  | { type: 'image'; dataUrl: string; size: number }
  | { type: 'image-preview-required'; size: number; message: string }
  | PdfDocumentPreviewDto
  | ArchivePreviewDto
  | WordDocumentPreviewDto
  | SpreadsheetDocumentPreviewDto;

export interface FileMetadataResult {
  path: string;
  size: number;
  createdAt: number | null;
  modifiedAt: number;
}

export interface FileGitDiffResult {
  changed: boolean;
  diff: string;
}

export function browseDirectory(path?: string): Promise<BrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  return requestJson(`/api/filesystem/browse${query}`);
}

export function browseHostFiles(path?: string): Promise<HostFileBrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  return requestJson(`/api/filesystem/browse-files${query}`);
}

export function authorizeHostFiles(paths: string[]): Promise<HostFileAuthorizationResponseDto> {
  return requestJson('/api/filesystem/authorize-host-files', {
    method: 'POST',
    ...jsonBody({ paths }),
  });
}

export function createDirectory(parentPath: string, name: string): Promise<CreateDirectoryResult> {
  return requestJson('/api/filesystem/directories', {
    method: 'POST',
    ...jsonBody({ parentPath, name }),
  });
}

interface FileRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function assertMediaPreviewCapacity(size: number): void {
  const limitMb = getEffectivePreviewPreferences().capacity.fileSizeMb;
  if (size > limitMb * 1024 * 1024) {
    throw new ApiError(400, { error: `音视频文件超过当前预览容量（${limitMb} MB），请调整预览容量或下载后查看`, code: 'FILE_PREVIEW_TOO_LARGE' });
  }
}

export async function readFile(path: string, accessToken?: string, options: FileRequestOptions = {}): Promise<FileReadResult> {
  const mediaType = getMediaFileType(path);
  if (mediaType) {
    // Metadata uses the same authorization boundary, including temporary file grants.
    const metadata = await readFileMetadata(path, accessToken, options);
    options.signal?.throwIfAborted();
    assertMediaPreviewCapacity(metadata.size);
    return { type: 'media', ...mediaType, size: metadata.size };
  }
  const query = new URLSearchParams({ path });
  if (accessToken) query.set('accessToken', accessToken);
  return requestJson(`/api/filesystem/read?${query.toString()}`, { signal: options.signal, timeoutMs: options.timeoutMs ?? 10_000 });
}

export function downloadFile(path: string, accessToken?: string, options: FileRequestOptions = {}): Promise<Blob> {
  const query = new URLSearchParams({ path });
  if (accessToken) query.set('accessToken', accessToken);
  return requestBlob(`/api/filesystem/download?${query.toString()}`, {
    signal: options.signal, timeoutMs: options.timeoutMs ?? 120_000, redirect: 'error',
  });
}

export function readFileMetadata(path: string, accessToken?: string, options: FileRequestOptions = {}): Promise<FileMetadataResult> {
  const query = new URLSearchParams({ path });
  if (accessToken) query.set('accessToken', accessToken);
  return requestJson(`/api/filesystem/metadata?${query.toString()}`, { signal: options.signal, timeoutMs: options.timeoutMs ?? 8_000 });
}

export function readFileGitDiff(path: string, accessToken?: string, options: FileRequestOptions = {}): Promise<FileGitDiffResult> {
  const query = new URLSearchParams({ path });
  if (accessToken) query.set('accessToken', accessToken);
  return requestJson(`/api/filesystem/git-diff?${query.toString()}`, { signal: options.signal, timeoutMs: options.timeoutMs ?? 8_000 });
}

export function readImagePreviewSource(path: string, accessToken?: string, options: FileRequestOptions = {}): Promise<Blob> {
  const query = new URLSearchParams({ path });
  if (accessToken) query.set('accessToken', accessToken);
  return requestBlob(`/api/filesystem/preview-image-source?${query.toString()}`, { signal: options.signal, timeoutMs: options.timeoutMs ?? 15_000 });
}

export function readPdfPreviewSource(path: string, accessToken?: string, options: FileRequestOptions = {}): Promise<Blob> {
  const query = new URLSearchParams({ path });
  if (accessToken) query.set('accessToken', accessToken);
  return requestBlob(`/api/filesystem/preview-pdf-source?${query.toString()}`, { signal: options.signal, timeoutMs: options.timeoutMs ?? 15_000 });
}

export function readSpreadsheetSheet(path: string, sheet: string, accessToken?: string, options: FileRequestOptions = {}): Promise<SpreadsheetSheetResponseDto> {
  const query = new URLSearchParams({ path, sheet });
  if (accessToken) query.set('accessToken', accessToken);
  return requestJson(`/api/filesystem/preview-spreadsheet-sheet?${query.toString()}`, { signal: options.signal, timeoutMs: options.timeoutMs ?? 10_000 });
}

export function authorizeFile(path: string, options: FileRequestOptions = {}): Promise<FileAccessResponseDto> {
  return requestJson('/api/filesystem/authorize-file', {
    method: 'POST',
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 8_000,
    ...jsonBody({ path }),
  });
}

export function revokeFile(accessToken: string, keepalive = false): Promise<OkDto> {
  return requestJson('/api/filesystem/revoke-file', {
    method: 'POST',
    keepalive,
    ...jsonBody({ accessToken }),
  });
}
