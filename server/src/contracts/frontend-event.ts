import { z } from 'zod';
import {
  MessageDtoSchema,
  MessageCursorDtoSchema,
  MessageSummaryDtoSchema,
  PendingApprovalResolutionSchema,
  PendingApprovalDtoSchema,
  ProcessItemDtoSchema,
  ProcessTimelineEntrySchema,
  ProjectDtoSchema,
  SessionDtoSchema,
  TokenUsageDtoSchema,
  UsageDtoSchema,
  NotificationPreferencesDtoSchema,
  AccountThemeSettingsDtoSchema,
  SidebarOrderDtoSchema,
  EngineConcurrencyDtoSchema,
  EnginePreferencesDtoSchema,
  TurnQueueSnapshotDtoSchema,
  SessionFollowupDtoSchema,
  PublicUserDtoSchema,
} from './dto.js';
import { RelayProtocolVersionSchema } from './protocol.js';

export const ProtocolInfoEventSchema = z.object({
  type: z.literal('protocol_info'),
  protocolVersion: RelayProtocolVersionSchema,
}).strict();

export const SyncStateEventSchema = z.object({
  type: z.literal('sync_state'),
  protocolVersion: RelayProtocolVersionSchema,
  sessionId: z.string().uuid(),
  messageRevision: z.number().int().nonnegative(),
  messageHasMore: z.boolean(),
  messageNextCursor: MessageCursorDtoSchema.nullable(),
  messages: z.array(MessageSummaryDtoSchema),
  isRunning: z.boolean(),
  currentContent: z.string(),
  processContent: z.string().optional(),
  processSteps: z.array(ProcessItemDtoSchema),
  processTimeline: z.array(ProcessTimelineEntrySchema).optional(),
  startTime: z.number().nullable(),
  requestForwarded: z.boolean(),
  isStopping: z.boolean(),
  queue: TurnQueueSnapshotDtoSchema.nullable().optional(),
}).strict();

export const RuntimeSyncStateEventSchema = z.object({
  type: z.literal('runtime_sync_state'),
  protocolVersion: RelayProtocolVersionSchema,
  sessionId: z.string().uuid(),
  isRunning: z.boolean(),
  currentContent: z.string(),
  processContent: z.string().optional(),
  processSteps: z.array(ProcessItemDtoSchema),
  processTimeline: z.array(ProcessTimelineEntrySchema).optional(),
  startTime: z.number().nullable(),
  requestForwarded: z.boolean(),
  isStopping: z.boolean(),
  queue: TurnQueueSnapshotDtoSchema.nullable().optional(),
}).strict();

export const EngineConcurrencyUpdatedEventSchema = z.object({
  type: z.literal('engine_concurrency_updated'),
  concurrency: EngineConcurrencyDtoSchema,
}).strict();

export const TurnQueueUpdatedEventSchema = z.object({
  type: z.literal('turn_queue_updated'),
  sessionId: z.string().uuid(),
  queue: TurnQueueSnapshotDtoSchema.nullable(),
}).strict();

export const TurnQueueStartedEventSchema = z.object({
  type: z.literal('turn_queue_started'),
  sessionId: z.string().uuid(),
  queueId: z.string().uuid(),
}).strict();

export const SessionFollowupSnapshotEventSchema = z.object({
  type: z.literal('session_followup_snapshot'),
  sessionId: z.string().uuid(),
  followups: z.array(SessionFollowupDtoSchema),
}).strict();

export const SessionFollowupUpdatedEventSchema = z.object({
  type: z.literal('session_followup_updated'),
  sessionId: z.string().uuid(),
  followup: SessionFollowupDtoSchema,
}).strict();

export const ItemStartEventSchema = z.object({
  type: z.literal('item_start'),
  sessionId: z.string().uuid(),
  item: ProcessItemDtoSchema,
}).strict();

export const ItemCompleteEventSchema = z.object({
  type: z.literal('item_complete'),
  sessionId: z.string().uuid(),
  item: ProcessItemDtoSchema,
}).strict();

export const MessageSavedEventSchema = z.object({
  type: z.literal('message_saved'),
  sessionId: z.string().uuid(),
  messageRevision: z.number().int().nonnegative(),
  message: MessageDtoSchema,
}).strict();

export const RequestForwardedEventSchema = z.object({
  type: z.literal('request_forwarded'),
  sessionId: z.string().uuid(),
}).strict();

export const TurnStartEventSchema = z.object({
  type: z.literal('turn_start'),
  sessionId: z.string().uuid(),
  turnId: z.string(),
}).strict();

export const TurnCompleteEventSchema = z.object({
  type: z.literal('turn_complete'),
  sessionId: z.string().uuid(),
  turnId: z.string(),
}).strict();

export const TurnCancellingEventSchema = z.object({
  type: z.literal('turn_cancelling'),
  sessionId: z.string().uuid(),
}).strict();

export const TurnCancelledEventSchema = z.object({
  type: z.literal('turn_cancelled'),
  sessionId: z.string().uuid(),
}).strict();

export const DeltaEventSchema = z.object({
  type: z.literal('delta'),
  sessionId: z.string().uuid(),
  itemId: z.string(),
  content: z.string(),
  phase: z.string().optional(),
  observedAt: z.number().int().nonnegative().optional(),
}).strict();

export const MessageCompleteEventSchema = z.object({
  type: z.literal('message_complete'),
  sessionId: z.string().uuid(),
  turnId: z.string(),
  content: z.string(),
  processContent: z.string().optional(),
  usage: UsageDtoSchema.nullable().optional(),
}).strict();

export const SessionUpdatedEventSchema = z.object({
  type: z.literal('session_updated'),
  sessionId: z.string().uuid(),
  session: SessionDtoSchema,
  snapshot: z.boolean().optional(),
}).strict();

export const EnginePreferencesUpdatedEventSchema = z.object({
  type: z.literal('engine_preferences_updated'),
  sessionId: z.string().uuid(),
  preferences: EnginePreferencesDtoSchema,
}).strict();

export const ModelInfoEventSchema = z.object({
  type: z.literal('model_info'),
  sessionId: z.string().uuid(),
  model: z.string(),
  platformOs: z.string().optional(),
  modelProvider: z.string().optional(),
  reasoningEffort: z.string().optional(),
}).strict();

export const TokenUsageEventSchema = z.object({
  type: z.literal('token_usage'),
  sessionId: z.string().uuid(),
  usage: TokenUsageDtoSchema,
  turnOutputUsage: TokenUsageDtoSchema.optional(),
  currentTurn: z.literal(true).optional(),
}).strict();

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  protocolVersion: RelayProtocolVersionSchema,
  sessionId: z.string().uuid().optional(),
  messageId: z.string().min(1).max(128).optional(),
  message: z.string(),
  code: z.string().optional(),
  commandType: z.enum(['subscribe', 'unsubscribe', 'send', 'cancel', 'cancel_followup', 'resume_followups', 'respond_interaction', 'mark_session_read']).optional(),
}).strict();

export const PendingApprovalsSnapshotEventSchema = z.object({
  type: z.literal('pending_approvals_snapshot'),
  approvals: z.array(PendingApprovalDtoSchema),
  live: z.boolean().optional(),
}).strict();

export const PendingApprovalUpsertedEventSchema = z.object({
  type: z.literal('pending_approval_upserted'),
  approval: PendingApprovalDtoSchema,
}).strict();

export const PendingApprovalResolvedEventSchema = z.object({
  type: z.literal('pending_approval_resolved'),
  sessionId: z.string().uuid(),
  interactionId: z.string().min(1),
  resolvedAction: PendingApprovalResolutionSchema,
  item: ProcessItemDtoSchema.optional(),
}).strict();

export const InteractionResponseResultEventSchema = z.object({
  type: z.literal('interaction_response_result'),
  operationId: z.string().uuid(),
  sessionId: z.string().uuid(),
  interactionId: z.string().min(1),
  outcome: z.enum(['accepted', 'skipped', 'failed']),
  message: z.string().min(1).optional(),
}).strict();

export const NotificationPreferencesUpdatedEventSchema = z.object({
  type: z.literal('notification_preferences_updated'),
  preferences: NotificationPreferencesDtoSchema,
}).strict();

export const ThemeSettingsUpdatedEventSchema = z.object({
  type: z.literal('theme_settings_updated'),
  settings: AccountThemeSettingsDtoSchema,
}).strict();

export const ConversationDefaultsUpdatedEventSchema = z.object({
  type: z.literal('conversation_defaults_updated'),
  user: PublicUserDtoSchema,
}).strict();

export const ApprovalTrustUpdatedEventSchema = z.object({
  type: z.literal('approval_trust_updated'),
  scope: z.enum(['project', 'session']),
  scopeId: z.string().uuid(),
}).strict();

export const SessionDeletedEventSchema = z.object({
  type: z.literal('session_deleted'),
  sessionId: z.string().uuid(),
}).strict();

export const SessionDeletionProgressEventSchema = z.object({
  type: z.literal('session_deletion_progress'),
  sessionId: z.string().uuid(),
  stage: z.enum(['stopping', 'archiving', 'saving']).nullable(),
}).strict();

export const ProjectUpdatedEventSchema = z.object({
  type: z.literal('project_updated'),
  project: ProjectDtoSchema,
}).strict();

export const ProjectDeletedEventSchema = z.object({
  type: z.literal('project_deleted'),
  projectId: z.string().uuid(),
}).strict();

export const SidebarOrderUpdatedEventSchema = z.object({
  type: z.literal('sidebar_order_updated'),
  order: SidebarOrderDtoSchema,
}).strict();

export const SharedFrontendEventSchema = z.discriminatedUnion('type', [
  SyncStateEventSchema,
  RuntimeSyncStateEventSchema,
  ItemStartEventSchema,
  ItemCompleteEventSchema,
  MessageSavedEventSchema,
  EngineConcurrencyUpdatedEventSchema,
  TurnQueueUpdatedEventSchema,
  TurnQueueStartedEventSchema,
  SessionFollowupSnapshotEventSchema,
  SessionFollowupUpdatedEventSchema,
]);

export const SessionReadsEventSchema = z.object({ type: z.literal('session_reads'), receipts: z.record(z.string()) }).strict();

export const FrontendEventSchema = z.discriminatedUnion('type', [
  SessionReadsEventSchema,
  ProtocolInfoEventSchema,
  SyncStateEventSchema,
  RuntimeSyncStateEventSchema,
  ItemStartEventSchema,
  ItemCompleteEventSchema,
  MessageSavedEventSchema,
  EngineConcurrencyUpdatedEventSchema,
  TurnQueueUpdatedEventSchema,
  TurnQueueStartedEventSchema,
  SessionFollowupSnapshotEventSchema,
  SessionFollowupUpdatedEventSchema,
  RequestForwardedEventSchema,
  TurnStartEventSchema,
  TurnCompleteEventSchema,
  TurnCancellingEventSchema,
  TurnCancelledEventSchema,
  DeltaEventSchema,
  MessageCompleteEventSchema,
  SessionUpdatedEventSchema,
  EnginePreferencesUpdatedEventSchema,
  SessionDeletionProgressEventSchema,
  SessionDeletedEventSchema,
  ProjectUpdatedEventSchema,
  ProjectDeletedEventSchema,
  ModelInfoEventSchema,
  TokenUsageEventSchema,
  PendingApprovalsSnapshotEventSchema,
  PendingApprovalUpsertedEventSchema,
  PendingApprovalResolvedEventSchema,
  InteractionResponseResultEventSchema,
  NotificationPreferencesUpdatedEventSchema,
  ThemeSettingsUpdatedEventSchema,
  ConversationDefaultsUpdatedEventSchema,
  ApprovalTrustUpdatedEventSchema,
  SidebarOrderUpdatedEventSchema,
  ErrorEventSchema,
]);

export type SyncStateEvent = z.infer<typeof SyncStateEventSchema>;
export type RuntimeSyncStateEvent = z.infer<typeof RuntimeSyncStateEventSchema>;
export type ItemStartEvent = z.infer<typeof ItemStartEventSchema>;
export type ItemCompleteEvent = z.infer<typeof ItemCompleteEventSchema>;
export type MessageSavedEvent = z.infer<typeof MessageSavedEventSchema>;
export type EngineConcurrencyUpdatedEvent = z.infer<typeof EngineConcurrencyUpdatedEventSchema>;
export type TurnQueueUpdatedEvent = z.infer<typeof TurnQueueUpdatedEventSchema>;
export type TurnQueueStartedEvent = z.infer<typeof TurnQueueStartedEventSchema>;
export type SharedFrontendEvent = z.infer<typeof SharedFrontendEventSchema>;
export type ProtocolInfoEvent = z.infer<typeof ProtocolInfoEventSchema>;
export type RequestForwardedEvent = z.infer<typeof RequestForwardedEventSchema>;
export type TurnStartEvent = z.infer<typeof TurnStartEventSchema>;
export type TurnCompleteEvent = z.infer<typeof TurnCompleteEventSchema>;
export type TurnCancellingEvent = z.infer<typeof TurnCancellingEventSchema>;
export type TurnCancelledEvent = z.infer<typeof TurnCancelledEventSchema>;
export type DeltaEvent = z.infer<typeof DeltaEventSchema>;
export type MessageCompleteEvent = z.infer<typeof MessageCompleteEventSchema>;
export type SessionUpdatedEvent = z.infer<typeof SessionUpdatedEventSchema>;
export type EnginePreferencesUpdatedEvent = z.infer<typeof EnginePreferencesUpdatedEventSchema>;
export type SessionDeletionProgressEvent = z.infer<typeof SessionDeletionProgressEventSchema>;
export type SessionDeletedEvent = z.infer<typeof SessionDeletedEventSchema>;
export type ProjectUpdatedEvent = z.infer<typeof ProjectUpdatedEventSchema>;
export type ProjectDeletedEvent = z.infer<typeof ProjectDeletedEventSchema>;
export type ModelInfoEvent = z.infer<typeof ModelInfoEventSchema>;
export type TokenUsageEvent = z.infer<typeof TokenUsageEventSchema>;
export type PendingApprovalsSnapshotEvent = z.infer<typeof PendingApprovalsSnapshotEventSchema>;
export type PendingApprovalUpsertedEvent = z.infer<typeof PendingApprovalUpsertedEventSchema>;
export type PendingApprovalResolvedEvent = z.infer<typeof PendingApprovalResolvedEventSchema>;
export type InteractionResponseResultEvent = z.infer<typeof InteractionResponseResultEventSchema>;
export type NotificationPreferencesUpdatedEvent = z.infer<typeof NotificationPreferencesUpdatedEventSchema>;
export type ThemeSettingsUpdatedEvent = z.infer<typeof ThemeSettingsUpdatedEventSchema>;
export type ConversationDefaultsUpdatedEvent = z.infer<typeof ConversationDefaultsUpdatedEventSchema>;
export type ApprovalTrustUpdatedEvent = z.infer<typeof ApprovalTrustUpdatedEventSchema>;
export type SidebarOrderUpdatedEvent = z.infer<typeof SidebarOrderUpdatedEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type FrontendEvent = z.infer<typeof FrontendEventSchema>;
