import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { UploadedFileDraftDto } from '../../contracts/index.js';
import type { StoredProjectUploads } from '../../services/stored-project-uploads.js';
import type { StoredDraftCleanup } from '../../services/stored-draft-cleanup.js';
import type { UploadReadScope } from '../../storage/contracts.js';
import { MAX_MESSAGE_UPLOAD_BYTES, MAX_UPLOAD_FILE_BYTES, normalizeUploadName } from '../../uploads/project-uploads.js';
import type { FeishuAttachment } from './inbound.js';
import { feishuAttachmentUploadId } from './native-session-scope.js';

export class FeishuAttachmentError extends Error {
  constructor(readonly reason: 'limit' | 'download' | 'upload') { super(reason); }
}

const imageExtensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/heic': 'heic', 'image/avif': 'avif',
};

function responseFilename(header: unknown) {
  if (typeof header !== 'string') return undefined;
  const encoded = /(?:^|;)\s*filename\*=utf-8'[^']*'([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim()); } catch { /* Fall through to the plain filename. */ }
  }
  const plain = /(?:^|;)\s*filename=(?:"([^"]+)"|([^;]+))/i.exec(header);
  return plain?.[1] ?? plain?.[2]?.trim();
}

export async function uploadFeishuAttachments(input: {
  resources: readonly FeishuAttachment[];
  getResource: Client['im']['messageResource']['get'];
  uploads: Pick<StoredProjectUploads, 'uploadInScope'>;
  cleanup: Pick<StoredDraftCleanup, 'deleteInScope'>;
  onCleanupFailure: () => void;
  readScope: () => Promise<UploadReadScope>;
  messageId: string;
  feishuMessageId: string;
  signal: AbortSignal;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-feishu-'));
  const filename = join(directory, 'attachment');
  const drafts: UploadedFileDraftDto[] = [];
  const pendingCleanup: { scope: UploadReadScope; uploadId: string }[] = [];
  let total = 0;
  try {
    for (const [index, resource] of input.resources.entries()) {
      input.signal.throwIfAborted();
      const scope = await input.readScope();
      const response = await input.getResource({ path: { message_id: input.feishuMessageId, file_key: resource.key },
        params: { type: resource.type } }).catch(() => { throw new FeishuAttachmentError('download'); });
      const body = response.getReadableStream();
      try {
        const headers = response.headers;
        const mimeType = String(headers?.['content-type'] ?? 'application/octet-stream').split(';', 1)[0]!.trim().toLowerCase();
        const maxSize = Math.min(MAX_UPLOAD_FILE_BYTES, MAX_MESSAGE_UPLOAD_BYTES - total);
        const declared = Number(headers?.['content-length']);
        if (Number.isFinite(declared) && declared > maxSize) throw new FeishuAttachmentError('limit');
        let size = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            callback(size > maxSize ? new FeishuAttachmentError('limit') : null, chunk);
          },
        });
        try {
          await pipeline(body, limit, createWriteStream(filename, { flags: 'wx', mode: 0o600 }),
            { signal: AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]) });
        } catch (error) {
          input.signal.throwIfAborted();
          throw error instanceof FeishuAttachmentError ? error : new FeishuAttachmentError('download');
        }
        const fallback = resource.type === 'image' ? `图片-${index + 1}.${imageExtensions[mimeType] ?? 'bin'}` : `附件-${index + 1}`;
        let name: string;
        try { name = normalizeUploadName(resource.name ?? responseFilename(headers?.['content-disposition']) ?? fallback); }
        catch { throw new FeishuAttachmentError('upload'); }
        input.signal.throwIfAborted();
        const uploadId = feishuAttachmentUploadId(input.messageId, resource);
        const file = createReadStream(filename);
        const closed = finished(file, { cleanup: true }).catch(() => undefined);
        let result: Awaited<ReturnType<StoredProjectUploads['uploadInScope']>>;
        try {
          result = await input.uploads.uploadInScope(scope.viewerUserId, {
            projectId: scope.projectId, messageId: input.messageId, uploadId, name, mimeType, size,
          }, Readable.toWeb(file) as ReadableStream<Uint8Array>, input.readScope, input.messageId);
        } finally {
          file.destroy();
          await closed;
        }
        if (result.state !== 'rejected') pendingCleanup.push({ scope, uploadId });
        if (result.state !== 'committed') {
          throw new FeishuAttachmentError(result.state === 'rejected' && result.code === 'PAYLOAD_TOO_LARGE' ? 'limit' : 'upload');
        }
        drafts.push(result.value.attachment);
        total += size;
      } finally {
        body.destroy();
        await rm(filename, { force: true });
      }
    }
    return drafts;
  } catch (error) {
    // Shutdown leaves recoverable drafts for the next attempt of the same inbox message.
    if (!input.signal.aborted) {
      for (const { scope, uploadId } of pendingCleanup) {
        const cleanup = await input.cleanup.deleteInScope(scope.viewerUserId, scope.projectId, uploadId, input.readScope, input.messageId);
        if (cleanup.state !== 'committed' && !input.signal.aborted) input.onCleanupFailure();
      }
    }
    throw error;
  } finally {
    await rmdir(directory);
  }
}
