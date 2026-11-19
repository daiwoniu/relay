import { z } from 'zod';
import {
  ANALYTICS_ATTRIBUTE_VALUES as values,ANALYTICS_FEATURES,ANALYTICS_MAX_DURATION,
  ANALYTICS_RESULTS,ANALYTICS_SURFACES,ANALYTICS_TOOL_IDS,type AnalyticsFeature,
} from './registry.js';

export const AnalyticsSurfaceSchema = z.enum(ANALYTICS_SURFACES);
export const AnalyticsToolIdSchema = z.enum(ANALYTICS_TOOL_IDS);
export const AnalyticsFeatureResultSchema = z.enum(ANALYTICS_RESULTS);
const duration = z.number().int().min(0).max(ANALYTICS_MAX_DURATION);
export const AnalyticsFeaturePropertiesSchema = z.object({
  feature: z.custom<AnalyticsFeature>(value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(ANALYTICS_FEATURES,value),'未登记功能'),
  action: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/),
  surface: AnalyticsSurfaceSchema,
  result: AnalyticsFeatureResultSchema.optional(),
  operationId: z.string().uuid().optional(),
  durationMs: duration.optional(),queueWaitMs: duration.optional(),firstOutputMs: duration.optional(),
  fileKind:z.enum(values.fileKind).optional(),sizeBucket:z.enum(values.sizeBucket).optional(),
  countBucket:z.enum(values.countBucket).optional(),engine:z.enum(values.engine).optional(),
  settingKey:z.enum(values.settingKey).optional(),mode:z.enum(values.mode).optional(),
  section:z.enum(values.section).optional(),trigger:z.enum(values.trigger).optional(),
  reasonCode:z.enum(values.reasonCode).optional(),toolId:AnalyticsToolIdSchema.optional(),
  queued:z.boolean().optional(),
}).strict();
export type AnalyticsFeatureProperties = z.infer<typeof AnalyticsFeaturePropertiesSchema>;
export type AnalyticsFeatureResult = z.infer<typeof AnalyticsFeatureResultSchema>;
export type AnalyticsToolId = z.infer<typeof AnalyticsToolIdSchema>;
