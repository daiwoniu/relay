import { z } from 'zod';
import { GlobalNewsPolicySchema, NewsSourceConfigSchema } from '../news/policy/global-policy.js';
import { PersonalNewsPreferencesSchema, PersonalNewsRuleSchema } from '../news/policy/personal-policy.js';

export const NewsPublicItemDtoSchema = z.object({
  id: z.string(), eventId: z.string(), sourceId: z.string(), sourceName: z.string(),
  url: z.string(), title: z.string(), description: z.string().nullable(),
  publishedAt: z.number().int(), categoryId: z.string(), topicIds: z.array(z.string()),
  entityIds: z.array(z.string()), eventTypeId: z.string().nullable(), language: z.string().nullable(),
  originalPublisher: z.string().nullable(), timeIsFallback: z.boolean(),
}).strict();

export const NewsPublicEventDtoSchema = NewsPublicItemDtoSchema.extend({
  sources: z.array(NewsPublicItemDtoSchema),
}).strict();

export const NewsVersionDtoSchema = z.object({
  version: z.number().int().nonnegative(), lastSuccessAt: z.number().int().nullable(), partialFailure: z.boolean(),
}).strict();

export const NewsPublicPageDtoSchema = NewsVersionDtoSchema.extend({
  items: z.array(NewsPublicEventDtoSchema), nextCursor: z.string().nullable(),
  categories: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  sources: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
}).strict();

export type NewsPublicPageDto = z.infer<typeof NewsPublicPageDtoSchema>;

export const NewsSourceConfigDtoSchema = NewsSourceConfigSchema;
export const NewsSourceStateDtoSchema = z.object({
  sourceId: z.string(), lastSuccessAt: z.number().nullable(), lastCheckedAt: z.number().nullable(),
  nextFetchAt: z.number().nullable(), etag: z.string().nullable(), lastModified: z.string().nullable(),
  lastError: z.string().nullable(), failureCount: z.number(), lastDurationMs: z.number().nullable(),
  lastFetchedCount: z.number().nullable(),
}).strict();
export const NewsAdminSourceDtoSchema = NewsSourceConfigDtoSchema.extend({ state: NewsSourceStateDtoSchema.nullable(), totalItemCount: z.number().int().nonnegative() });
export const NewsAdminSourcesDtoSchema = z.object({ sources: z.array(NewsAdminSourceDtoSchema) }).strict();
export const NewsGlobalPolicyDtoSchema = GlobalNewsPolicySchema;
export const NewsPolicyPreviewDtoSchema = z.object({
  matches: z.array(z.object({ id: z.string(), title: z.string(), reason: z.string() }).strict()),
  capped: z.boolean(),
}).strict();

export const NewsPersonalRuleDtoSchema = PersonalNewsRuleSchema;
export const NewsPersonalPreferencesDtoSchema = PersonalNewsPreferencesSchema;
export const NewsMemberEventDtoSchema = NewsPublicEventDtoSchema.extend({ matchReason: z.string().nullable() });
export const NewsMemberPageDtoSchema = NewsPublicPageDtoSchema.omit({ items: true }).extend({
  items: z.array(NewsMemberEventDtoSchema), hasFollowRules: z.boolean(),
}).strict();
