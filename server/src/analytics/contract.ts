import { z } from 'zod';
import { validateAnalyticsRegistration } from './registry.js';
import { AnalyticsFeaturePropertiesSchema, AnalyticsToolIdSchema } from './feature-schema.js';
import { analyticsPageIds } from './pages.js';

export const ANALYTICS_DAY = 86_400_000;
export const AnalyticsPageSchema = z.enum(analyticsPageIds);
export const AnalyticsToolSchema = AnalyticsToolIdSchema;
export const AnalyticsActionSchema = z.enum(['format','minify','validate','copy','export_png','export_svg','compare','start','complete','cancel','calculate','randomize']);
export const AnalyticsResultSchema = z.enum(['success','invalid_input','error','cancelled','rejected','throttled']);
export const AnalyticsRangeSchema = z.enum(['today','24h','7d','30d','custom','all']);
const errorCode = z.enum(['INVALID_INPUT','COPY_FAILED','EXPORT_FAILED','OPERATION_FAILED']).optional();
const context = {
  id: z.string().uuid(), page: AnalyticsPageSchema, pageViewId: z.string().uuid().nullable(),
  referrerHost: z.union([z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),z.string().ip()]).nullable(),
  sourceType:z.enum(['external','internal','none']).optional(),
  device: z.enum(['desktop','mobile','tablet','unknown']),
  browser: z.enum(['Chrome','Edge','Firefox','Safari','WeChat','Huawei','Xiaomi','QQ','UC','Quark','Samsung','Opera','Other']),
  os: z.enum(['Windows','Android','HarmonyOS','HyperOS','MIUI','iOS','iPadOS','macOS','Linux','Other']),
  clientSource: z.enum(['web','pwa']).optional(),
  clientVersion: z.string().min(1).max(40).regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/).optional(),
};
const pageView = z.object({ ...context, name: z.literal('page_view'), properties: z.object({}).strict() }).strict();
const toolOpen = z.object({ ...context, name: z.literal('tool_open'), properties: z.object({toolId:AnalyticsToolSchema}).strict() }).strict();
const toolAction = z.object({ ...context, name: z.literal('tool_action'), properties: z.object({
  toolId:AnalyticsToolSchema, action:AnalyticsActionSchema, result:AnalyticsResultSchema.exclude(['rejected','throttled']),
  errorCode, durationMs:z.number().int().min(0).max(86_400_000).optional(),
}).strict() }).strict();
const newsClick = z.object({ ...context, name:z.literal('news_click'), properties:z.object({
  newsId:z.string().max(128).regex(/^[a-zA-Z0-9:._-]+$/),
}).strict() }).strict();
const validSource=(e:{sourceType?:string;referrerHost:string|null})=>!e.sourceType||(e.sourceType==='external'?e.referrerHost!==null:e.referrerHost===null);
const featureView = z.object({ ...context, name:z.literal('feature_view'), properties:AnalyticsFeaturePropertiesSchema }).strict();
const featureAction = z.object({ ...context, name:z.literal('feature_action'), properties:AnalyticsFeaturePropertiesSchema }).strict();
const operationResult = z.object({ ...context, name:z.literal('operation_result'), properties:AnalyticsFeaturePropertiesSchema }).strict();
export const AnalyticsClientEventSchema = z.discriminatedUnion('name',[pageView,toolOpen,toolAction,newsClick,featureView,featureAction,operationResult])
  .superRefine((event,ctx)=>validateAnalyticsRegistration(event,'client',ctx))
  .refine(validSource,{message:'来源状态与主机不一致',path:['referrerHost']});
export const AnalyticsBatchSchema = z.object({ events:z.array(AnalyticsClientEventSchema).min(1).max(20) }).strict();
const serverEvent = z.object({ ...context, clientSource:z.enum(['web','pwa','gateway']).optional(), name:z.enum(['login_result','hosting_document']), properties:z.object({
  result:AnalyticsResultSchema.optional(), siteId:z.string().max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(),
}).strict() }).strict();
const serverOperationResult = operationResult.extend({clientSource:z.enum(['web','pwa','gateway']).optional()})
  .superRefine((event,ctx)=>validateAnalyticsRegistration(event,'server',ctx));
export const AnalyticsEventSchema = z.union([AnalyticsClientEventSchema,serverEvent,serverOperationResult]).refine(validSource,{message:'来源状态与主机不一致',path:['referrerHost']});
export const AnalyticsRecordSchema = z.object({
  event:AnalyticsEventSchema, receivedAt:z.number().int().positive(), visitorId:z.string().uuid().nullable(),
  userId:z.string().max(128).nullable(), role:z.enum(['guest','member','admin']), ip:z.string().max(45).ip().nullable(),
  version:z.string().max(40),
  accessHost:z.string().min(1).max(253).regex(/^[a-z0-9_:.-]+$/).optional(),
  networkType:z.enum(['internal','public','unknown']).optional(),
}).strict();
export const AnalyticsQuerySchema = z.object({range:AnalyticsRangeSchema.default('7d'),excludeAdmin:z.boolean().default(false),excludeInternal:z.boolean().optional(),
  startAt:z.number().int().min(0).max(253402300799999).optional(),endAt:z.number().int().min(0).max(253402300799999).optional(),
  feature:z.string().max(50).regex(/^(?:[a-z][a-z0-9_]*|tool\.[a-z][a-z0-9_]*)$/).optional(),
  action:z.string().max(40).regex(/^[a-z][a-z0-9_]*$/).optional(),result:z.enum(['success','error','invalid_input','cancelled','rejected','throttled','unknown']).optional(),
  metric:z.enum(['view','action','result','system']).optional(),includeSystem:z.boolean().optional(),operationId:z.string().uuid().optional(),
  pageSize:z.union([z.literal(10),z.literal(50),z.literal(100)]).optional(),
}).strict().refine(({range,startAt,endAt})=>range==='custom'?startAt!==undefined&&endAt!==undefined&&startAt<endAt:startAt===undefined&&endAt===undefined,{message:'日期范围无效'});
export type AnalyticsClientEvent = z.infer<typeof AnalyticsClientEventSchema>;
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsRecord = z.infer<typeof AnalyticsRecordSchema>;
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;
export type AnalyticsPrincipal = {kind:'user';userId:string;authSessionHash:string};
export type AnalyticsTrendCount={pv:number;uv:number;network?:{public:number;internal:number;unknown:number}};
export interface AnalyticsSummary {
  since:number; until?:number; earliest:number|null; totalStored:number;
  totals:{pv:number;uv:number;users:number;actions:number;hosting:number;logins:number;news:number};
  daily:Array<AnalyticsTrendCount&{day:string}>;
  trend?:{start:number;step:number;points:Array<AnalyticsTrendCount&{at:number}>};
  pages:Array<{label:string;count:number}>; tools:Array<{label:string;opens:number;actions:number}>;
  results:Array<{label:string;count:number}>; sources:Array<{label:string;count:number}>;
  devices:Array<{label:string;count:number}>; hosting:Array<{label:string;count:number}>;
  loginResults:Array<{label:string;count:number}>;
}
export interface AnalyticsVisit {id:string;at:number;name:string;page:string;role:string;ip:string|null;device:string;browser:string;os:string;source:string|null;sourceType?:'external'|'internal'|'none'|null;result:string|null;siteId:string|null;clientSource?:'web'|'pwa'|'gateway'|null;clientVersion?:string|null;serverVersion?:string|null;accessHost?:string|null;accessType?:'ip'|'domain'|null;backfilled?:boolean;networkType?:'internal'|'public'|'unknown'|null}
export interface AnalyticsStoragePort {
  appendAnalytics(input:{records:AnalyticsRecord[]}):Promise<{accepted:number}>;
  readAnalytics(input:{principal:AnalyticsPrincipal;query:AnalyticsQuery;view:'summary'|'visits'}):Promise<AnalyticsSummary|AnalyticsVisit[]>;
}
export const ANALYTICS_SCHEMA_SQL = `CREATE TABLE analytics_events(
 id TEXT PRIMARY KEY,received_at INTEGER NOT NULL,name TEXT NOT NULL,page TEXT NOT NULL,page_view_id TEXT,
 visitor_id TEXT,user_id TEXT,role TEXT NOT NULL,ip TEXT,version TEXT NOT NULL,
 referrer_host TEXT,device TEXT NOT NULL,browser TEXT NOT NULL,os TEXT NOT NULL,properties TEXT NOT NULL);
 CREATE INDEX analytics_events_time ON analytics_events(received_at);
 CREATE INDEX analytics_events_name_time ON analytics_events(name,received_at);`;
