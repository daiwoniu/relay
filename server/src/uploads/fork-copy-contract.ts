import path from 'node:path';
import { z } from 'zod';
const identity = z.object({ projectId: z.string().uuid(), userId: z.string().uuid() }).strict();
export const ForkUploadCopyInputSchema = z.object({ operationId: z.string().min(1).max(256),
  projectPath: z.string().min(1).max(32768).refine((v) => path.isAbsolute(v) && !v.includes('\0')),
  sourceMessageId: z.string().uuid(), targetMessageId: z.string().uuid(),
  sourceAttachmentIds: z.array(z.string().uuid()).min(1).max(100).refine((v) => new Set(v).size === v.length),
  sourceIdentity: identity, targetIdentity: identity }).strict();
