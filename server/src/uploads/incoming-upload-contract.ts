import { z } from 'zod';
import { normalizeUploadName,MAX_UPLOAD_FILE_BYTES } from './project-uploads.js';
const uuid=z.string().uuid().refine(value=>value===value.toLowerCase());
export const IncomingUploadRequestSchema=z.object({
  version:z.literal(1),jobId:uuid,projectId:uuid,userId:uuid,messageId:uuid,uploadId:uuid,attachmentId:uuid,
  name:z.string().min(1).max(255).refine(value=>{try{return normalizeUploadName(value)===value;}catch{return false;}}),
  mimeType:z.string().min(1).max(255).refine(value=>value===value.trim().toLowerCase()&&!/[\x00-\x1f\x7f]/.test(value)),
  size:z.number().int().nonnegative().max(MAX_UPLOAD_FILE_BYTES),createdAt:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type IncomingUploadRequest=z.infer<typeof IncomingUploadRequestSchema>;
