import path from 'node:path';
import { z } from 'zod';
import { UploadedFileDraftDtoSchema,HostFileAttachmentDtoSchema,MessageAttachmentDtoSchema } from '../contracts/index.js';
export const UploadPromotionInputSchema=z.object({projectPath:z.string().min(1).max(32768).refine(value=>path.isAbsolute(value)&&!value.includes('\0')),
  projectId:z.string().uuid(),userId:z.string().uuid(),messageId:z.string().uuid(),uploads:z.array(UploadedFileDraftDtoSchema).max(10),hosts:z.array(HostFileAttachmentDtoSchema).max(10)}).strict()
  .refine(value=>value.uploads.length+value.hosts.length<=10);
export type UploadPromotionInput=z.infer<typeof UploadPromotionInputSchema>;
export const UploadInspectInputSchema=UploadPromotionInputSchema.innerType().omit({uploads:true,hosts:true}).extend({attachments:z.array(MessageAttachmentDtoSchema).max(10)}).strict();
export type UploadInspectInput=z.infer<typeof UploadInspectInputSchema>;
