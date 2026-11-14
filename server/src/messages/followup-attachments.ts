import { z } from 'zod';
import { MessageAttachmentDtoSchema, SendAttachmentDtoSchema, type MessageAttachmentDto } from '../contracts/index.js';

const storedAttachments = z.array(z.union([MessageAttachmentDtoSchema, SendAttachmentDtoSchema])).max(10);

// Older followups store drafts; native storage stores already prepared attachments.
// Only publish display fields, never host-file access tokens or upload identifiers.
export function presentFollowupAttachments(json: string): MessageAttachmentDto[] {
  return storedAttachments.parse(JSON.parse(json)).map((item) => item.kind === 'host_file'
    ? { id: item.id, kind: item.kind, name: item.name, path: item.path, size: item.size }
    : { id: item.id, kind: item.kind, name: item.name, path: item.path, size: item.size,
      mimeType: item.mimeType, available: 'available' in item ? item.available : true });
}
