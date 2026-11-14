import type { HostFileAttachmentDto, UploadedFileDraftDto } from '../../generated/relay-contracts';

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_MESSAGE_UPLOAD_BYTES = 200 * 1024 * 1024;

export type HostAttachmentDraft = HostFileAttachmentDto & { status: 'ready' };
export type ReadyUploadedAttachmentDraft = UploadedFileDraftDto & { status: 'ready'; previewUrl?: string };
export type PendingUploadedAttachmentDraft = {
  id: string;
  kind: 'uploaded_file';
  status: 'uploading' | 'failed';
  messageId: string;
  uploadId: string;
  name: string;
  size: number;
  mimeType: string;
  progress: number;
  file: File;
  previewUrl?: string;
  error?: string;
};
export type AttachmentDraft = HostAttachmentDraft | ReadyUploadedAttachmentDraft | PendingUploadedAttachmentDraft;
export type PersistedAttachmentDraft = HostFileAttachmentDto | UploadedFileDraftDto;

function isHostDraft(value: unknown): value is HostFileAttachmentDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return typeof source.id === 'string' && source.kind === 'host_file' && typeof source.name === 'string'
    && typeof source.path === 'string' && Number.isInteger(source.size) && Number(source.size) >= 0;
}

function isUploadedDraft(value: unknown): value is UploadedFileDraftDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return typeof source.id === 'string' && source.kind === 'uploaded_file' && typeof source.uploadId === 'string'
    && typeof source.messageId === 'string' && typeof source.projectId === 'string' && typeof source.name === 'string' && typeof source.path === 'string'
    && Number.isInteger(source.size) && Number(source.size) >= 0 && typeof source.mimeType === 'string';
}

export function getAttachmentDraftKey(chatDraftKey: string): string {
  return `${chatDraftKey}:attachments`;
}

export function readAttachmentDrafts(storage: Pick<Storage, 'getItem'>, key: string): AttachmentDraft[] {
  const raw = storage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): AttachmentDraft[] => {
      if (isHostDraft(entry)) return [{ ...entry, status: 'ready' }];
      if (isUploadedDraft(entry)) return [{ ...entry, status: 'ready' }];
      return [];
    }).slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  } catch { return []; }
}

export function writeAttachmentDrafts(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string,
  attachments: AttachmentDraft[],
): void {
  const persisted: PersistedAttachmentDraft[] = [];
  for (const attachment of attachments) {
    if (attachment.status !== 'ready') continue;
    if (attachment.kind === 'host_file') {
      const { status: _status, ...draft } = attachment;
      persisted.push(draft);
      continue;
    }
    const { status: _status, previewUrl: _previewUrl, ...draft } = attachment;
    persisted.push(draft);
  }
  if (persisted.length > 0) storage.setItem(key, JSON.stringify(persisted));
  else storage.removeItem(key);
}

export function mergeHostAttachmentDrafts(
  current: AttachmentDraft[],
  incoming: HostFileAttachmentDto[],
): { attachments: AttachmentDraft[]; duplicateCount: number; overflowCount: number } {
  const attachments = [...current];
  const pathKey = (filePath: string) => /^[A-Za-z]:[\\/]/.test(filePath) ? filePath.toLowerCase() : filePath;
  const seen = new Set(current.filter((entry): entry is HostAttachmentDraft => entry.kind === 'host_file').map((entry) => pathKey(entry.path)));
  let duplicateCount = 0;
  let overflowCount = 0;
  for (const attachment of incoming) {
    const key = pathKey(attachment.path);
    if (seen.has(key)) { duplicateCount += 1; continue; }
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) { overflowCount += 1; continue; }
    seen.add(key);
    attachments.push({ ...attachment, status: 'ready' });
  }
  return { attachments, duplicateCount, overflowCount };
}

export function selectUploadFiles(current: AttachmentDraft[], files: File[]): {
  accepted: File[];
  rejectedLarge: number;
  rejectedTotal: number;
  rejectedDuplicate: number;
  rejectedOverflow: number;
} {
  const accepted: File[] = [];
  let rejectedLarge = 0;
  let rejectedTotal = 0;
  let rejectedDuplicate = 0;
  let rejectedOverflow = 0;
  let uploadBytes = current.filter((entry) => entry.kind === 'uploaded_file').reduce((sum, entry) => sum + entry.size, 0);
  const seen = new Set(current.filter((entry) => entry.kind === 'uploaded_file').map((entry) => `${entry.name}\0${entry.size}`));
  for (const file of files) {
    const key = `${file.name}\0${file.size}`;
    if (seen.has(key)) { rejectedDuplicate += 1; continue; }
    if (current.length + accepted.length >= MAX_ATTACHMENTS_PER_MESSAGE) { rejectedOverflow += 1; continue; }
    if (file.size > MAX_UPLOAD_FILE_BYTES) { rejectedLarge += 1; continue; }
    if (uploadBytes + file.size > MAX_MESSAGE_UPLOAD_BYTES) { rejectedTotal += 1; continue; }
    seen.add(key);
    uploadBytes += file.size;
    accepted.push(file);
  }
  return { accepted, rejectedLarge, rejectedTotal, rejectedDuplicate, rejectedOverflow };
}

export function hasUnreadyAttachments(attachments: AttachmentDraft[]): boolean {
  return attachments.some((attachment) => attachment.status !== 'ready');
}
