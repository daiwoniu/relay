import { z } from 'zod';
import { IncomingUploadRequestSchema } from './incoming-upload-contract.js';
export const UploadPublishInputSchema=z.object({projectPath:z.string().min(1).max(32768).refine(value=>!value.includes('\0')),
  request:IncomingUploadRequestSchema,digest:z.string().regex(/^[a-f0-9]{64}$/),mode:z.enum(['inspect','publish'])}).strict();
export type UploadPublishInput=z.infer<typeof UploadPublishInputSchema>;
