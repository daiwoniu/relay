import { z } from 'zod';

export const HOSTING_UPLOAD_BYTES = 32 * 1024 * 1024;
export const HOSTING_EXPANDED_BYTES = 128 * 1024 * 1024;
export const HOSTING_FILE_COUNT = 1500;
export const HostingPublicIdSchema = z.string().regex(/^[a-z0-9]{10}$/);
export const HostingPathSchema = z.string().min(1).max(512).refine(value =>
  !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part =>
    !!part && part !== '.' && part !== '..' && !/[\x00-\x1f:]/.test(part)));
export const HostedSiteSchema = z.object({
  id: z.string().uuid(), publicId: HostingPublicIdSchema.optional(), name: z.string().trim().min(1).max(80), entry: HostingPathSchema,
  enabled: z.boolean(), fileCount: z.number().int().min(1).max(HOSTING_FILE_COUNT),
  totalBytes: z.number().int().min(1).max(HOSTING_EXPANDED_BYTES),
  contentToken: z.string().uuid(), createdAt: z.number().int().positive(), updatedAt: z.number().int().positive(),
}).strict();
export type HostedSite = z.infer<typeof HostedSiteSchema>;
export const HostingSaveSchema = z.object({ site: HostedSiteSchema, expectedToken: z.string().uuid().nullable() }).strict();
export type HostingSaveInput = z.infer<typeof HostingSaveSchema>;
export const HostingDeleteSchema = z.object({ id: z.string().uuid(), expectedToken: z.string().uuid() }).strict();
export const HostingPatchSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0);
export const HostingInspectionSchema = z.object({
  uploadId:z.string().uuid(),previewToken:z.string(),expiresAt:z.number(),entries:z.array(z.string()),suggestedEntry:z.string().nullable(),
  fileCount:z.number(),totalBytes:z.number(),rewritten:z.number(),warnings:z.array(z.string()),warningCount:z.number(),
});
export type HostingInspection = z.infer<typeof HostingInspectionSchema>;
export const HOSTING_SCHEMA_SQL = `CREATE TABLE hosted_sites (
  id TEXT PRIMARY KEY, site_json TEXT NOT NULL CHECK(length(site_json)<=4096), updated_at INTEGER NOT NULL)`;
export function hostingUrl(id: string, entry = '') {
  return `/p/${id}/${entry.split('/').map(encodeURIComponent).join('/')}`;
}
