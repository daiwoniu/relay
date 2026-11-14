import type { HostFileAttachmentDto } from '../../generated/relay-contracts';

export type HostFileDraft = HostFileAttachmentDto;

function pathKey(filePath: string): string {
  return /^[A-Za-z]:[\\/]/.test(filePath) ? filePath.toLowerCase() : filePath;
}

function isHostFileDraft(value: unknown): value is HostFileDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return typeof source.id === 'string'
    && source.kind === 'host_file'
    && typeof source.name === 'string'
    && typeof source.path === 'string'
    && typeof source.size === 'number'
    && Number.isInteger(source.size)
    && source.size >= 0;
}

export function getHostFileDraftKey(chatDraftKey: string): string {
  return `${chatDraftKey}:host-files`;
}

export function readHostFileDrafts(storage: Pick<Storage, 'getItem'>, key: string): HostFileDraft[] {
  const raw = storage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return mergeHostFileDrafts([], parsed.filter(isHostFileDraft)).attachments;
  } catch {
    return [];
  }
}

export function writeHostFileDrafts(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string,
  attachments: HostFileDraft[],
): void {
  if (attachments.length > 0) storage.setItem(key, JSON.stringify(attachments));
  else storage.removeItem(key);
}

export function mergeHostFileDrafts(
  current: HostFileDraft[],
  incoming: HostFileDraft[],
  limit = 10,
): { attachments: HostFileDraft[]; duplicateCount: number; overflowCount: number } {
  const attachments = [...current];
  const seen = new Set(current.map((attachment) => pathKey(attachment.path)));
  let duplicateCount = 0;
  let overflowCount = 0;
  for (const attachment of incoming) {
    const key = pathKey(attachment.path);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    if (attachments.length >= limit) {
      overflowCount += 1;
      continue;
    }
    seen.add(key);
    attachments.push(attachment);
  }
  return { attachments, duplicateCount, overflowCount };
}
