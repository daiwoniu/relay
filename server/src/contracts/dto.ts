import { z } from 'zod';

export const SessionStatusSchema = z.enum([
  'idle',
  'queued',
  'pending',
  'processing',
  'recovering',
  'awaiting_action',
  'stopping',
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);

export const EngineIdSchema = z.enum(['codex', 'codebuddy', 'opencode', 'zcode']);

export const ReasoningOptionDtoSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).optional(),
}).strict();

export const EngineModelDtoSchema = z.object({
  id: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(1_000).optional(),
  isDefault: z.boolean(),
  inputModalities: z.array(z.enum(['text', 'image'])).min(1).max(2),
  contextWindow: z.number().int().positive().optional(),
  costLabel: z.string().trim().min(1).max(120).optional(),
  serviceTiers: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(120),
  }).strict()).max(8).optional(),
  defaultServiceTier: z.string().trim().min(1).max(64).optional(),
  reasoning: z.object({
    supported: z.boolean(),
    scope: z.enum(['model', 'session']),
    defaultOptionId: z.string().trim().min(1).max(64).optional(),
    options: z.array(ReasoningOptionDtoSchema).max(32),
  }).strict(),
}).strict();

export const EngineModelCatalogDtoSchema = z.object({
  engineId: EngineIdSchema,
  fetchedAt: z.number().int().nonnegative(),
  stale: z.boolean(),
  configurationRead: z.boolean().optional(),
  models: z.array(EngineModelDtoSchema).max(500),
  configuredDefaults: z.object({
    modelId: z.string().trim().min(1).max(200).optional(),
    reasoningEffort: z.string().trim().min(1).max(64).optional(),
    serviceTier: z.string().trim().min(1).max(64).optional(),
  }).strict().optional(),
}).strict();

export const EnginePreferencesDtoSchema = z.object({
  modelId: z.string().trim().min(1).max(200).nullable(),
  reasoningEffort: z.string().trim().min(1).max(64).nullable(),
  serviceTier: z.string().trim().min(1).max(64).nullable().optional(),
  revision: z.number().int().nonnegative(),
}).strict();

export const ApprovalTrustDurationSchema = z.enum(['one_hour', 'eight_hours', 'permanent']);
export const ApprovalTrustModeSchema = z.enum(['trusted', 'manual']);
export const ApprovalTrustSettingDtoSchema = z.object({
  scope: z.enum(['project', 'session']),
  mode: ApprovalTrustModeSchema,
  expiresAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export const EffectiveApprovalTrustDtoSchema = z.object({
  trusted: z.boolean(),
  source: z.enum(['manual', 'session_trust', 'project_trust']),
  effectiveScope: z.enum(['session', 'project']).nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  sessionOverridesProject: z.boolean(),
  diagnostic: z.enum(['scope_unavailable', 'read_failed']).nullable(),
}).strict();
export const ApprovalTrustStateDtoSchema = z.object({
  projectSetting: ApprovalTrustSettingDtoSchema.nullable(),
  sessionSetting: ApprovalTrustSettingDtoSchema.nullable(),
  effective: EffectiveApprovalTrustDtoSchema,
}).strict();
export const PutProjectApprovalTrustRequestSchema = z.object({
  duration: ApprovalTrustDurationSchema,
}).strict();
export const PutSessionApprovalTrustRequestSchema = z.object({
  mode: ApprovalTrustModeSchema,
  duration: ApprovalTrustDurationSchema,
}).strict();

export const ModelExecutionDescriptorDtoSchema = z.object({
  id: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().trim().min(1).max(64).optional(),
  provider: z.string().trim().min(1).max(120).optional(),
}).strict();

export const RequestedModelExecutionDescriptorDtoSchema = ModelExecutionDescriptorDtoSchema
  .omit({ provider: true })
  .partial({ displayName: true })
  .strict();

export const MessageModelInfoDtoSchema = z.object({
  engineId: EngineIdSchema,
  requested: RequestedModelExecutionDescriptorDtoSchema.optional(),
  effective: ModelExecutionDescriptorDtoSchema,
  serviceTier: z.string().trim().min(1).max(64).nullable().optional(),
  resolvedServiceTier: z.string().trim().min(1).max(64).nullable().optional(),
  rerouted: z.boolean(),
}).strict();

export const ClientHintBrandDtoSchema = z.object({
  brand: z.string().max(128),
  version: z.string().max(128),
}).strict();

export const ClientHintHighEntropyDtoSchema = z.object({
  architecture: z.string().max(64).optional(),
  bitness: z.string().max(32).optional(),
  formFactors: z.array(z.string().max(64)).max(20).optional(),
  fullVersionList: z.array(ClientHintBrandDtoSchema).max(20).optional(),
  model: z.string().max(256).optional(),
  platformVersion: z.string().max(128).optional(),
  uaFullVersion: z.string().max(128).optional(),
  wow64: z.boolean().optional(),
}).strict();

export const ClientDiagnosticsDtoSchema = z.object({
  capturedAt: z.number().int().nonnegative(),
  userAgent: z.string().max(4096),
  appVersion: z.string().max(4096).optional(),
  platform: z.string().max(128).optional(),
  vendor: z.string().max(128).optional(),
  language: z.string().max(64).optional(),
  languages: z.array(z.string().max(64)).max(20).optional(),
  timezone: z.string().max(128).optional(),
  hardwareConcurrency: z.number().int().positive().max(1024).optional(),
  deviceMemory: z.number().positive().max(1024).optional(),
  maxTouchPoints: z.number().int().nonnegative().max(100).optional(),
  cookieEnabled: z.boolean().optional(),
  doNotTrack: z.string().max(32).optional(),
  webdriver: z.boolean().optional(),
  pdfViewerEnabled: z.boolean().optional(),
  standalone: z.boolean(),
  online: z.boolean().optional(),
  userAgentData: z.object({
    mobile: z.boolean().optional(),
    platform: z.string().max(128).optional(),
    brands: z.array(ClientHintBrandDtoSchema).max(20).optional(),
    highEntropy: ClientHintHighEntropyDtoSchema.optional(),
  }).strict().optional(),
  screen: z.object({
    width: z.number().int().nonnegative().max(100_000).optional(),
    height: z.number().int().nonnegative().max(100_000).optional(),
    availWidth: z.number().int().nonnegative().max(100_000).optional(),
    availHeight: z.number().int().nonnegative().max(100_000).optional(),
    colorDepth: z.number().int().nonnegative().max(1024).optional(),
    pixelDepth: z.number().int().nonnegative().max(1024).optional(),
    devicePixelRatio: z.number().finite().positive().max(100).optional(),
    orientationType: z.string().max(64).optional(),
    orientationAngle: z.number().finite().min(-360).max(360).optional(),
  }).strict().optional(),
  viewport: z.object({
    width: z.number().finite().nonnegative().max(100_000).optional(),
    height: z.number().finite().nonnegative().max(100_000).optional(),
    outerWidth: z.number().finite().nonnegative().max(100_000).optional(),
    outerHeight: z.number().finite().nonnegative().max(100_000).optional(),
    visualWidth: z.number().finite().nonnegative().max(100_000).optional(),
    visualHeight: z.number().finite().nonnegative().max(100_000).optional(),
    visualScale: z.number().finite().positive().max(100).optional(),
    visualOffsetLeft: z.number().finite().min(-100_000).max(100_000).optional(),
    visualOffsetTop: z.number().finite().min(-100_000).max(100_000).optional(),
  }).strict().optional(),
  connection: z.object({
    type: z.string().max(32).optional(),
    effectiveType: z.string().max(32).optional(),
    downlink: z.number().finite().nonnegative().max(1_000_000).optional(),
    rtt: z.number().finite().nonnegative().max(3_600_000).optional(),
    saveData: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const ClientEnvironmentDtoSchema = z.object({
  source: z.enum(['web', 'pwa']),
  deviceType: z.enum(['desktop', 'phone', 'tablet']),
  osName: z.string().trim().min(1).max(40).optional(),
  osVersion: z.string().trim().min(1).max(40).optional(),
  browserName: z.string().trim().min(1).max(40).optional(),
  browserVersion: z.string().trim().min(1).max(80).optional(),
  relayVersion: z.string().trim().min(1).max(40),
}).strict();

export const MessageOriginDtoSchema = z.object({
  senderUserId: z.string().min(1).max(128),
  senderUsername: z.string().min(1).max(128),
  senderDisplayName: z.string().min(1).max(128),
  ip: z.string().min(1).max(128),
  receivedAt: z.number().int().nonnegative(),
  client: ClientEnvironmentDtoSchema.optional(),
}).strict();

export const EngineCapacityWindowDtoSchema = z.object({
  windowMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
  totalCount: z.number().int().nonnegative(),
  overloadCount: z.number().int().nonnegative(),
  requestRetryCount: z.number().int().nonnegative(),
  completionRetryCount: z.number().int().nonnegative(),
  cooldownCount: z.number().int().nonnegative(),
  startAcceptedCount: z.number().int().nonnegative(),
}).strict();

export const EngineConcurrencyDtoSchema = z.object({
  resourceKey: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,119}$/),
  engineId: EngineIdSchema,
  label: z.string().trim().min(1).max(80),
  maxActiveTurns: z.number().int().min(1).max(32),
  activeTurns: z.number().int().nonnegative(),
  queuedTurns: z.number().int().nonnegative(),
  cooldownUntil: z.number().int().nonnegative().nullable(),
  probeInProgress: z.boolean(),
  windows: z.array(EngineCapacityWindowDtoSchema).length(3),
}).strict();

export const TurnQueueSnapshotDtoSchema = z.object({
  queueId: z.string().uuid(),
  sessionId: z.string().uuid(),
  engineId: EngineIdSchema,
  resourceKey: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,119}$/),
  label: z.string().trim().min(1).max(80),
  state: z.enum(['queued', 'claimed']),
  position: z.number().int().positive().nullable(),
  activeTurns: z.number().int().nonnegative(),
  maxActiveTurns: z.number().int().min(1).max(32),
  cooldownUntil: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
}).strict();

export const ResourceOwnerDtoSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(['admin', 'member']),
  avatarUpdatedAt: z.number().nullable(),
}).strict();

export const ProjectDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  pinned: z.union([z.literal(0), z.literal(1)]),
  pinned_at: z.number().int().nonnegative().nullable(),
  is_system: z.union([z.literal(0), z.literal(1)]),
  deletion_protected: z.union([z.literal(0), z.literal(1)]).optional(),
  access_role: z.enum(['owner', 'viewer', 'collaborator', 'manager']).optional(),
  members_can_view_sessions: z.union([z.literal(0), z.literal(1)]).optional(),
  session_count: z.number().int().nonnegative().optional(),
  owner: ResourceOwnerDtoSchema.nullable().optional(),
}).strict();

export const SessionDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  pinned: z.union([z.literal(0), z.literal(1)]),
  pinned_at: z.number().int().nonnegative().nullable(),
  project_id: z.string().nullable(),
  engine: EngineIdSchema.nullable(),
  codex_archived: z.boolean(),
  can_fork: z.boolean(),
  status: SessionStatusSchema,
  last_result: z.object({
    messageId: z.string(), turnId: z.string(),
    status: z.enum(['completed', 'failed', 'stopped', 'interrupted']),
    createdAt: z.number(), executionStage: z.enum(['accepted', 'started', 'responding']).optional(),
  }).strict().nullable().optional(),
  pending_action_kind: z.enum(['approval', 'input', 'mixed']).nullable().optional(),
  execution_stage: z.enum(['accepted', 'started', 'responding']).nullable().optional(),
  engine_preferences: EnginePreferencesDtoSchema,
  message_count: z.number().int().nonnegative().optional(),
  assistant_message_count: z.number().int().nonnegative().optional(),
  context_compaction_count: z.number().int().nonnegative().optional(),
  owner: ResourceOwnerDtoSchema.nullable().optional(),
}).strict();

export const SessionDetailsDtoSchema = SessionDtoSchema.extend({
  engine_session_id: z.string().nullable(),
}).strict();

export const SessionDeletionImpactDtoSchema = z.object({
  hasLinkedCodexThread: z.boolean(),
}).strict();

export const ProjectDeletionImpactDtoSchema = z.object({
  sessionCount: z.number().int().nonnegative(),
  linkedCodexSessionCount: z.number().int().nonnegative(),
  inProgressSessionCount: z.number().int().nonnegative(),
}).strict();

export const TrashProjectDtoSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(100), path: z.string().min(1).max(2048),
  deletedAt: z.number().int().nonnegative(), sessionCount: z.number().int().nonnegative(),
  creator: ResourceOwnerDtoSchema.nullable().optional(), deletedBy: ResourceOwnerDtoSchema.nullable().optional(),
  matchSessionId: z.string().uuid().optional(), matchSessionTitle: z.string().optional(), matchSessionMessageCount: z.number().int().nonnegative().optional(),
  matchSessionAssistantMessageCount: z.number().int().nonnegative().optional(),
  matchSessionEngine: EngineIdSchema.nullable().optional(), matchSessionEngineSessionId: z.string().nullable().optional(),
  matchSessionDeletedAt: z.number().int().nonnegative().optional(),
  matchSessionCreator: ResourceOwnerDtoSchema.nullable().optional(), matchSessionDeletedBy: ResourceOwnerDtoSchema.nullable().optional(),
  matchMessageId: z.string().uuid().optional(), matchCount: z.number().int().nonnegative().optional(), matchSnippet: z.string().optional(),
}).strict();
export const TrashSessionDtoSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(200), projectId: z.string().uuid(),
  engineSessionId: z.string().nullable(),
  projectName: z.string().trim().min(1).max(100), engine: EngineIdSchema.nullable(), deletedAt: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(), matchMessageId: z.string().uuid().optional(),
  assistantMessageCount: z.number().int().nonnegative().optional(),
  creator: ResourceOwnerDtoSchema.nullable().optional(), deletedBy: ResourceOwnerDtoSchema.nullable().optional(),
  matchCount: z.number().int().nonnegative().optional(), matchSnippet: z.string().optional(),
}).strict();
export const TrashProjectListResponseDtoSchema = z.object({
  items: z.array(TrashProjectDtoSchema), total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100), offset: z.number().int().nonnegative(),
}).strict();
export const TrashSessionListResponseDtoSchema = z.object({
  items: z.array(TrashSessionDtoSchema), total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100), offset: z.number().int().nonnegative(),
}).strict();
export const TrashRestoreResponseDtoSchema = z.object({
  ok: z.literal(true),
  restoredSessionCount: z.number().int().nonnegative(),
  unarchivedSessionCount: z.number().int().nonnegative(),
  unarchiveFailedSessionCount: z.number().int().nonnegative(),
  archiveStateSyncFailedSessionCount: z.number().int().nonnegative(),
}).strict();
export const TrashImpactDtoSchema = z.object({
  sessionCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  assistantMessageCount: z.number().int().nonnegative().optional(),
  shareCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  releasableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  impactRevision: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const TrashProjectDeleteRequestSchema = z.object({
  impactRevision: z.string().regex(/^[0-9a-f]{64}$/),
  confirmationName: z.string().min(1).max(100),
}).strict();
export const TrashSessionDeleteRequestSchema = z.object({
  impactRevision: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const TrashDeleteResponseDtoSchema = z.object({
  ok: z.literal(true),
  cleanupPending: z.boolean(),
}).strict();

const ProjectSidebarOrderScopeSchema = z.string().regex(
  /^project:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);

export const SidebarOrderScopeSchema = z.union([
  z.literal('projects'),
  z.literal('pinned'),
  ProjectSidebarOrderScopeSchema,
]);

export const SidebarOrderItemDtoSchema = z.object({
  type: z.enum(['project', 'session']),
  id: z.string().uuid(),
}).strict();

export const SidebarOrderDtoSchema = z.object({
  scope: SidebarOrderScopeSchema,
  custom: z.boolean(),
  items: z.array(SidebarOrderItemDtoSchema),
}).strict();

export const SidebarOrdersResponseDtoSchema = z.object({
  orders: z.array(SidebarOrderDtoSchema),
}).strict();

export const MoveSidebarOrderRequestSchema = z.object({
  scope: SidebarOrderScopeSchema,
  item: SidebarOrderItemDtoSchema,
  before: SidebarOrderItemDtoSchema.nullable(),
}).strict();

export const MoveSidebarOrderResponseDtoSchema = z.object({
  order: SidebarOrderDtoSchema,
}).strict();

export const PublicUserDtoSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(['admin', 'member']),
  avatarUpdatedAt: z.number().nullable(),
  defaultProjectId: z.string().uuid().nullable(),
  defaultEngine: EngineIdSchema,
  defaultModelId: z.string().nullable(),
  mustChangePassword: z.boolean(),
  disabledAt: z.number().nullable(),
  canCreateProject: z.boolean().optional(),
}).strict();

export const PendingApprovalKindSchema = z.enum([
  'command_approval',
  'file_approval',
  'permissions_approval',
  'mcp_elicitation',
  'user_input',
  'async_question',
]);

export const ApprovalActionSchema = z.enum([
  'accept',
  'accept_for_session',
  'decline',
  'cancel',
]);

export const PendingApprovalResolutionSchema = z.enum([
  'accept',
  'accept_for_session',
  'decline',
  'cancel',
  'submitted',
  'resolved_elsewhere',
  'invalidated',
]);

export const PendingApprovalDtoSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().uuid(),
  sessionTitle: z.string().min(1),
  engine: EngineIdSchema,
  kind: PendingApprovalKindSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.record(z.unknown()),
  availableActions: z.array(ApprovalActionSchema),
  createdAt: z.number().int().nonnegative(),
}).strict();

export const ProcessItemStatusSchema = z.enum(['in_progress', 'completed', 'incomplete']);
export const ExecutionStageSchema = z.enum(['accepted', 'started', 'responding']);
export const MessageOutcomeSchema = z.enum(['completed', 'failed', 'stopped', 'interrupted']);
export const ChangedFileTypeSchema = z.enum(['added', 'modified', 'deleted']);
const ProjectChangedFilePathSchema = z.string().min(1).max(4096).regex(
  /^(?![A-Za-z]:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*[\u0000-\u001F\u007F]).+$/,
);
const ExternalChangedFilePathSchema = z.string().min(1).max(4096).regex(
  /^(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))(?!.*[\u0000-\u001F\u007F])(?:(?:[A-Za-z]:[\\/])|(?:\\\\[^\\/]+[\\/][^\\/]+)|\/).+$/,
);

const ChangedFileDtoObjectSchema = z.object({
  path: z.string().min(1).max(4096),
  changeType: ChangedFileTypeSchema,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  external: z.literal(true).optional(),
}).strict();

export const ChangedFileDtoSchema = ChangedFileDtoObjectSchema.superRefine((value, context) => {
  const valid = value.external === true
    ? ExternalChangedFilePathSchema.safeParse(value.path).success
    : value.external === undefined && ProjectChangedFilePathSchema.safeParse(value.path).success;
  if (!valid) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: '文件路径与作用域不一致' });
  }
});

export const HostFileAttachmentDtoSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('host_file'),
  name: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(32_768),
  size: z.number().int().nonnegative(),
}).strict();

export const AuthorizedHostFileAttachmentDtoSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('host_file'),
  name: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(32_768),
  size: z.number().int().nonnegative(),
  accessToken: z.string().uuid(),
}).strict();

export const HostFileAttachmentSummaryDtoSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('host_file'),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative(),
}).strict();

export const UploadedFileDraftDtoSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('uploaded_file'),
  messageId: z.string().uuid(),
  uploadId: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(32_768),
  size: z.number().int().nonnegative().max(50 * 1024 * 1024),
  mimeType: z.string().trim().min(1).max(255),
}).strict();

export const UploadedFileAttachmentDtoSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('uploaded_file'),
  name: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(32_768),
  size: z.number().int().nonnegative().max(50 * 1024 * 1024),
  mimeType: z.string().trim().min(1).max(255),
  available: z.boolean(),
}).strict();

export const UploadedFileAttachmentSummaryDtoSchema = UploadedFileAttachmentDtoSchema.omit({ path: true });

export const MessageAttachmentDtoSchema = z.discriminatedUnion('kind', [
  HostFileAttachmentDtoSchema,
  UploadedFileAttachmentDtoSchema,
]);

export const SendAttachmentDtoSchema = z.discriminatedUnion('kind', [
  AuthorizedHostFileAttachmentDtoSchema,
  UploadedFileDraftDtoSchema,
]);

export const SessionFollowupDtoSchema = z.object({
  id: z.string().min(1).max(128),
  sessionId: z.string().uuid(),
  content: z.string(),
  attachments: z.array(MessageAttachmentDtoSchema).max(10).optional(),
  state: z.enum(['received', 'steering', 'steered', 'queued', 'dispatching', 'delivered', 'paused', 'uncertain', 'cancelled']),
  createdAt: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  replyToAsyncQuestionId: z.string().nullable(),
}).strict();

export const MessageAttachmentSummaryDtoSchema = z.discriminatedUnion('kind', [
  HostFileAttachmentSummaryDtoSchema,
  UploadedFileAttachmentSummaryDtoSchema,
]);

export const ApprovalDecisionSourceSchema = z.enum([
  'user', 'session_trust', 'project_trust', 'resolved_elsewhere',
]);
export const ApprovalDecisionScopeSchema = z.enum(['session', 'project']);
export const InteractionResolvedActionSchema = z.enum([
  'accept', 'accept_for_session', 'decline', 'cancel', 'submit', 'submitted', 'resolved_elsewhere',
]);

export const ProcessItemDtoSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  status: ProcessItemStatusSchema,
  details: z.record(z.unknown()),
}).strict();

export const ProcessTimelineEntrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('narrative'),
    itemId: z.string().min(1),
    content: z.string(),
    firstObservedAt: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    type: z.literal('operation'),
    itemId: z.string().min(1),
  }).strict(),
]);

export const TokenUsageDtoSchema = z.object({
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reasoningOutputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  modelContextWindow: z.number().positive().nullable(),
}).strict();

export const MessageDtoSchema = z.object({
  requestTurnId: z.string().min(1).max(256).optional(),
  replyToAsyncQuestionId: z.string().startsWith('async-question:').max(256).optional(),
  id: z.string(),
  session_id: z.string(),
  turn_id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  phase: z.string().nullable(),
  created_at: z.number(),
  duration: z.number().nullable(),
  stopped: z.boolean(),
  isError: z.boolean().optional(),
  items: z.array(ProcessItemDtoSchema).optional(),
  processContent: z.string().optional(),
  processTimeline: z.array(ProcessTimelineEntrySchema).optional(),
  changedFiles: z.array(ChangedFileDtoSchema).max(500).optional(),
  changedFilesIncomplete: z.boolean().optional(),
  executionStage: ExecutionStageSchema.optional(),
  outcome: MessageOutcomeSchema.optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().max(16_384).optional(),
  tokenUsage: TokenUsageDtoSchema.optional(),
  attachments: z.array(MessageAttachmentDtoSchema).max(10).optional(),
  modelInfo: MessageModelInfoDtoSchema.optional(),
  origin: MessageOriginDtoSchema.optional(),
}).strict();

export const MessageSummaryDtoSchema = MessageDtoSchema.omit({
  items: true,
  processContent: true,
  processTimeline: true,
}).extend({
  historicalOperationRecord: z.boolean().optional(),
  asyncQuestionIds: z.array(z.string().startsWith('async-question:')).optional(),
  hasDetails: z.boolean(),
  processItemCount: z.number().int().nonnegative(),
  processNarrativeCount: z.number().int().nonnegative(),
  changedFileCount: z.number().int().nonnegative(),
}).strict();

export const MessageDetailsDtoSchema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.string().min(1),
  items: z.array(ProcessItemDtoSchema).optional(),
  processContent: z.string().optional(),
  processTimeline: z.array(ProcessTimelineEntrySchema).optional(),
  changedFiles: z.array(ChangedFileDtoSchema).max(500).optional(),
  changedFilesIncomplete: z.boolean().optional(),
}).strict();

export const SubAgentReportDtoSchema = z.object({ content: z.string().min(1).max(200_000) }).strict();

export const MessageCursorDtoSchema = z.object({
  beforeCreatedAt: z.number().int().nonnegative(),
  beforeId: z.string().min(1),
}).strict();

export const MessagePageDtoSchema = z.object({
  sessionId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: MessageCursorDtoSchema.nullable(),
  messages: z.array(MessageSummaryDtoSchema),
}).strict();

export const MessagePageResultDtoSchema = z.discriminatedUnion('unchanged', [
  z.object({
    unchanged: z.literal(true),
    revision: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    unchanged: z.literal(false),
    page: MessagePageDtoSchema,
  }).strict(),
]);

export const UsageDtoSchema = z.object({
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  totalTokens: z.number().optional(),
}).strict();

export const ApiErrorDtoSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  canForceAccess: z.boolean().optional(),
  projectInTrash: z.object({
    id: z.string().uuid(), name: z.string().trim().min(1).max(100), sessionCount: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();

export const OkDtoSchema = z.object({ ok: z.literal(true) }).strict();

export const AuthResponseDtoSchema = z.object({
  user: PublicUserDtoSchema,
  expiresAt: z.number().optional(),
}).strict();

export const UserResponseDtoSchema = z.object({
  user: PublicUserDtoSchema,
}).strict();

export const UserListResponseDtoSchema = z.object({
  users: z.array(PublicUserDtoSchema),
}).strict();

export const NotificationSoundSchema = z.enum(['gentle_dual', 'crisp', 'soft_chime', 'short_tone', 'high_dual', 'rising_triple', 'falling_low']);

export const NotificationPreferencesDtoSchema = z.object({
  desktopSystemEnabled: z.boolean(),
  desktopSoundEnabled: z.boolean(),
  desktopSessionEndSystemEnabled: z.boolean(),
  desktopSessionEndSoundEnabled: z.boolean(),
  mobileSystemEnabled: z.boolean(),
  mobileSoundEnabled: z.boolean(),
  mobileSessionEndSystemEnabled: z.boolean(),
  mobileSessionEndSoundEnabled: z.boolean(),
  approvalSound: NotificationSoundSchema,
  sessionEndSound: NotificationSoundSchema,
  desktopSoundVolume: z.number().int().min(10).max(100).multipleOf(5),
  mobileSoundVolume: z.number().int().min(10).max(100).multipleOf(5),
}).strict();

export const NotificationPreferencesResponseDtoSchema = z.object({
  preferences: NotificationPreferencesDtoSchema,
}).strict();

export const ThemePreferenceSchema = z.enum(['light', 'dark', 'system']);
export const ThemeColorStyleSchema = z.enum(['neutral', 'aurora']);
export const ThemeTextScaleSchema = z.enum(['compact', 'standard', 'large']);
export const ThemeBackgroundKindSchema = z.enum(['none', 'preset', 'asset']);
export const ThemeBackgroundFitSchema = z.enum(['cover', 'contain']);
export const ThemeBackgroundPositionSchema = z.enum(['center', 'top', 'bottom', 'left', 'right']);

export const ThemeProfileDtoSchema = z.object({
  backgroundKind: ThemeBackgroundKindSchema,
  backgroundValue: z.string().max(100).nullable(),
  blur: z.number().int().min(0).max(24),
  fit: ThemeBackgroundFitSchema,
  position: ThemeBackgroundPositionSchema,
  overlayColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  overlayOpacity: z.number().min(0).max(0.75),
  panelOpacity: z.number().min(0.35).max(1),
  glassBlur: z.number().int().min(0).max(24),
  borderStrength: z.number().min(0).max(1),
}).strict();

export const ThemeSettingsV1Schema = z.object({
  version: z.literal(1),
  basePreference: ThemePreferenceSchema,
  linkedProfiles: z.boolean(),
  desktop: ThemeProfileDtoSchema,
  mobile: ThemeProfileDtoSchema,
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const AccountThemeSettingsDtoSchema = z.object({
  version: z.literal(2),
  basePreference: ThemePreferenceSchema,
  colorStyle: ThemeColorStyleSchema,
  textScale: ThemeTextScaleSchema,
  linkedProfiles: z.boolean(),
  desktop: ThemeProfileDtoSchema,
  mobile: ThemeProfileDtoSchema,
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const ThemeSettingsInputSchema = z.union([
  ThemeSettingsV1Schema,
  AccountThemeSettingsDtoSchema,
]);

export const AccountThemeSettingsResponseDtoSchema = z.object({
  settings: AccountThemeSettingsDtoSchema,
}).strict();

export const ThemeAssetResponseDtoSchema = z.object({
  assetId: z.string().uuid(),
}).strict();

export const SessionUpdateResponseDtoSchema = z.object({
  ok: z.literal(true),
  session: SessionDtoSchema,
}).strict();

export const MessageSearchSnippetDtoSchema = z.object({
  text: z.string(),
  matchStart: z.number().int().nonnegative(),
  matchLength: z.number().int().nonnegative(),
}).strict();

export const SessionMessageMatchDtoSchema = z.object({
  messageId: z.string(),
  role: z.enum(['user', 'assistant']),
  createdAt: z.number(),
  scope: z.enum(['message', 'process', 'operation']),
  itemId: z.string().min(1).optional(),
  snippet: MessageSearchSnippetDtoSchema,
}).strict();

export const SessionSearchResultDtoSchema = z.object({
  session: SessionDtoSchema,
  titleMatched: z.boolean(),
  messageMatchCount: z.number().int().nonnegative(),
  latestMessageMatch: SessionMessageMatchDtoSchema.nullable(),
}).strict();

export const SessionSearchResponseDtoSchema = z.object({
  query: z.string(),
  results: z.array(SessionSearchResultDtoSchema),
}).strict();

export const SessionMessageMatchesResponseDtoSchema = z.object({
  query: z.string(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  matches: z.array(SessionMessageMatchDtoSchema),
}).strict();

export const FileAccessResponseDtoSchema = z.object({
  ok: z.literal(true),
  accessToken: z.string(),
}).strict();

export const ArchiveEntryDtoSchema = z.object({
  path: z.string().min(1).max(1024),
  directory: z.boolean(),
  size: z.number().int().nonnegative().safe(),
  compressedSize: z.number().int().nonnegative().safe(),
  modifiedAt: z.number().finite().nullable(),
}).strict();

export const ArchivePreviewDtoSchema = z.object({
  type: z.literal('archive'),
  format: z.literal('zip'),
  entries: z.array(ArchiveEntryDtoSchema).max(1000),
  totalEntries: z.number().int().nonnegative().max(5000),
  totalFiles: z.number().int().nonnegative().max(5000),
  totalSize: z.number().int().nonnegative().safe(),
  totalCompressedSize: z.number().int().nonnegative().safe(),
  truncated: z.boolean(),
  size: z.number().int().nonnegative(),
}).strict();

export const PdfDocumentPreviewDtoSchema = z.object({
  type: z.literal('pdf-document'),
  totalPages: z.number().int().positive(),
  displayedPages: z.number().int().positive().max(500),
  truncated: z.boolean(),
  size: z.number().int().nonnegative(),
}).strict();

export const WordDocumentPreviewDtoSchema = z.object({
  type: z.literal('word-document'),
  html: z.string(),
  countUnit: z.enum(['pages', 'blocks']),
  totalCount: z.number().int().nonnegative(),
  displayedCount: z.number().int().nonnegative().max(500),
  truncated: z.boolean(),
  imageCount: z.number().int().nonnegative(),
  omittedImageCount: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
}).strict();

export const SpreadsheetCellDtoSchema = z.object({
  column: z.number().int().positive().max(300),
  address: z.string().min(1).max(32),
  display: z.string().max(10_000),
  formula: z.string().max(10_000).optional(),
}).strict();

export const SpreadsheetRowDtoSchema = z.object({
  rowNumber: z.number().int().positive(),
  cells: z.array(SpreadsheetCellDtoSchema).max(300),
}).strict();

export const SpreadsheetSheetSummaryDtoSchema = z.object({
  name: z.string().min(1).max(31),
  state: z.enum(['visible', 'hidden', 'veryHidden']),
  totalRows: z.number().int().nonnegative(),
  totalColumns: z.number().int().nonnegative(),
}).strict();

export const SpreadsheetSheetPreviewDtoSchema = z.object({
  name: z.string().min(1).max(31),
  totalRows: z.number().int().nonnegative(),
  totalColumns: z.number().int().nonnegative(),
  displayedRows: z.number().int().nonnegative().max(1000),
  displayedColumns: z.number().int().nonnegative().max(300),
  rowsTruncated: z.boolean(),
  columnsTruncated: z.boolean(),
  rows: z.array(SpreadsheetRowDtoSchema).max(1000),
  merges: z.array(z.string().max(64)).max(500),
}).strict();

export const SpreadsheetDocumentPreviewDtoSchema = z.object({
  type: z.literal('spreadsheet'),
  sheets: z.array(SpreadsheetSheetSummaryDtoSchema).max(100),
  activeSheet: SpreadsheetSheetPreviewDtoSchema,
  size: z.number().int().nonnegative(),
}).strict();

export const SpreadsheetSheetResponseDtoSchema = z.object({
  sheet: SpreadsheetSheetPreviewDtoSchema,
}).strict();

export const HostFileAuthorizationResponseDtoSchema = z.object({
  attachments: z.array(AuthorizedHostFileAttachmentDtoSchema).min(1).max(10),
}).strict();

export const ProjectUploadUsageDtoSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  reservedBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
  archivedFileCount: z.number().int().nonnegative(),
  temporaryFileCount: z.number().int().nonnegative(),
}).strict();

export const ProjectUploadResponseDtoSchema = z.object({
  attachment: UploadedFileDraftDtoSchema,
  usage: ProjectUploadUsageDtoSchema,
}).strict();

export const ProjectUploadedFileDtoSchema = UploadedFileAttachmentSummaryDtoSchema.extend({
  createdAt: z.number().int().nonnegative(),
}).strict();

export const ProjectUploadsResponseDtoSchema = z.object({
  usage: ProjectUploadUsageDtoSchema,
  files: z.array(ProjectUploadedFileDtoSchema),
  cleanupBlockedReason: z.string().nullable(),
}).strict();

export const ProjectUploadDeleteResponseDtoSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
  usage: ProjectUploadUsageDtoSchema,
}).strict();

export const ProjectUploadCleanupPendingDtoSchema=z.object({
  state:z.literal('committed'),deletedCount:z.number().int().nonnegative(),cleanupPending:z.boolean(),usagePending:z.literal(true),
}).strict();

export const ReleaseOverviewTopicSchema = z.enum([
  'permissions_security',
  'mcp_extensions',
  'plugins_skills',
  'tasks_sessions',
  'multi_agent',
  'models_providers',
  'windows_cross_platform',
  'context_compaction',
  'connection_stability',
  'terminal_ui',
]);

const ReleaseOverviewBaseSchema = z.object({
  sourceStatus: z.enum(['available', 'metadata_only', 'unavailable', 'unrecognized']),
  counts: z.object({
    features: z.number().int().nonnegative().max(1_000),
    improvements: z.number().int().nonnegative().max(1_000),
    fixes: z.number().int().nonnegative().max(1_000),
    documentation: z.number().int().nonnegative().max(1_000),
    chores: z.number().int().nonnegative().max(1_000),
  }).strict(),
  topics: z.array(ReleaseOverviewTopicSchema).max(3),
});

export const CodexReleaseOverviewDtoSchema = ReleaseOverviewBaseSchema.extend({
  officialSource: z.literal('codex_github'),
  officialUrl: z.string().regex(/^https:\/\/github\.com\/openai\/codex\/releases\/tag\/rust-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
}).strict();

export const CodeBuddyReleaseOverviewDtoSchema = ReleaseOverviewBaseSchema.extend({
  officialSource: z.literal('codebuddy_cnb'),
  officialUrl: z.string().regex(/^https:\/\/cnb\.cool\/codebuddy\/codebuddy-code\/-\/blob\/main\/(?:docs\/release-notes\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.md|CHANGELOG\.md)$/),
}).strict();

export const ZcodeReleaseOverviewDtoSchema = ReleaseOverviewBaseSchema.extend({
  officialSource: z.literal('zcode_changelog'),
  officialUrl: z.string().regex(/^https:\/\/zcode\.z\.ai\/(?:cn\/)?changelog$/),
}).strict();

export const ReleaseOverviewDtoSchema = z.discriminatedUnion('officialSource', [
  CodexReleaseOverviewDtoSchema,
  CodeBuddyReleaseOverviewDtoSchema,
  ZcodeReleaseOverviewDtoSchema,
]);

export const CodexVersionDtoSchema = z.object({
  currentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  releaseOverview: CodexReleaseOverviewDtoSchema.nullable(),
  releasePublishedAt: z.number().int().nonnegative().max(8_640_000_000_000_000).nullable().optional(),
  updateAvailable: z.boolean().nullable(),
  status: z.enum(['checking', 'success', 'error']),
  checkedAt: z.number().nullable(),
}).strict();

export const EngineCapabilitiesDtoSchema = z.object({
  conversations: z.boolean(),
  streaming: z.boolean(),
  processItems: z.boolean(),
  cancellation: z.boolean(),
  interactions: z.boolean(),
  tokenUsage: z.boolean(),
  archive: z.boolean(),
}).strict();

export const EngineStatusDtoSchema = z.object({
  id: EngineIdSchema,
  label: z.string(),
  ideInstalled: z.boolean(),
  cliInstalled: z.boolean(),
  processReady: z.boolean(),
  protocolReady: z.boolean(),
  available: z.boolean(),
  availabilityStage: z.enum(['not_installed', 'installed_auth_required', 'protocol_incompatible', 'readiness_stale', 'readiness_failed', 'ready']),
  code: z.string(),
  message: z.string(),
  version: z.string().nullable(),
  capabilities: EngineCapabilitiesDtoSchema,
}).strict();

export const EngineStatusResponseDtoSchema = z.object({
  engines: z.array(EngineStatusDtoSchema),
}).strict();

export const SystemResourceStatusDtoSchema = z.object({
  available: z.boolean(),
  level: z.enum(['normal', 'warning', 'critical', 'unknown']),
  committedBytes: z.number().int().nonnegative().nullable(),
  commitLimitBytes: z.number().int().positive().nullable(),
  usagePercent: z.number().nonnegative().nullable(),
  observedAt: z.number().int().nonnegative(),
  warningThresholdPercent: z.number().min(0).max(100),
  criticalThresholdPercent: z.number().min(0).max(100),
  processMemory: z.object({
    relay: z.object({
      privateBytes: z.number().int().nonnegative(),
      backendPrivateBytes: z.number().int().nonnegative(),
      processCount: z.number().int().positive(),
      scope: z.enum(['managed', 'backend']),
    }).strict().nullable(),
    topProcesses: z.array(z.object({
      name: z.string().min(1).max(120).regex(/^[^\\/:\x00-\x1f]+$/),
      privateBytes: z.number().int().nonnegative(),
      processCount: z.number().int().positive(),
    }).strict()).max(5),
  }).strict().nullable().optional(),
}).strict();

export const EngineMaintenanceActionSchema = z.enum(['install', 'restart', 'upgrade', 'upgrade_and_restart', 'recheck']);
export const EngineAvailabilityStageSchema = z.enum(['not_installed', 'installed_auth_required', 'protocol_incompatible', 'readiness_stale', 'readiness_failed', 'ready', 'install_failed']);
export const EngineMaintenanceInstallSourceSchema = z.enum(['official_npm_global', 'desktop', 'unknown']);
export const EngineMaintenanceReadinessSchema = z.enum(['ready', 'stale', 'failed', 'unknown']);
export const EngineMaintenanceLatestCheckStatusSchema = z.enum(['idle', 'checking', 'success', 'error']);

export const EngineInstanceVersionDtoSchema = z.object({
  version: z.string().nullable(),
  count: z.number().int().nonnegative(),
}).strict();

export const EngineMaintenanceActionDtoSchema = z.object({
  action: EngineMaintenanceActionSchema,
  label: z.string().min(1).max(120),
  enabled: z.boolean(),
  reason: z.string().max(300).nullable(),
  interruptsActiveTasks: z.boolean(),
}).strict();

export const EngineMaintenanceStatusDtoSchema = z.object({
  engineId: EngineIdSchema,
  label: z.string().min(1).max(64),
  installedVersion: z.string().nullable(),
  installedAt: z.number().int().nonnegative().max(8_640_000_000_000_000).nullable(),
  runningVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  releaseOverview: ReleaseOverviewDtoSchema.nullable(),
  releasePublishedAt: z.number().int().nonnegative().max(8_640_000_000_000_000).nullable().optional(),
  updateAvailable: z.boolean().nullable(),
  latestCheckStatus: EngineMaintenanceLatestCheckStatusSchema,
  latestCheckedAt: z.number().int().nonnegative().nullable(),
  installSource: EngineMaintenanceInstallSourceSchema,
  activeTaskCount: z.number().int().nonnegative(),
  activeInstanceCount: z.number().int().nonnegative(),
  instanceVersions: z.array(EngineInstanceVersionDtoSchema).max(20),
  readiness: EngineMaintenanceReadinessSchema,
  readinessCheckedAt: z.number().int().nonnegative().nullable(),
  availabilityStage: EngineAvailabilityStageSchema.optional(),
  statusMessage: z.string().min(1).max(300).optional(),
  loginCommand: z.string().min(1).max(64).nullable().optional(),
  recommendedAction: EngineMaintenanceActionSchema.nullable(),
  actions: z.array(EngineMaintenanceActionDtoSchema).max(4),
}).strict().superRefine((value, context) => {
  if (!value.releaseOverview) return;
  const expectedSource = value.engineId === 'codex'
    ? 'codex_github'
    : value.engineId === 'zcode'
      ? 'zcode_changelog'
      : 'codebuddy_cnb';
  if (value.releaseOverview.officialSource !== expectedSource) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['releaseOverview', 'officialSource'],
      message: 'release overview source does not match engine',
    });
  }
});

export const EngineMaintenanceResponseDtoSchema = z.object({
  engines: z.array(EngineMaintenanceStatusDtoSchema),
}).strict();

export const CodexAccountRateLimitDtoSchema = z.object({
  limitId: z.string().min(1).max(120),
  limitName: z.string().max(120).nullable(),
  windowType: z.enum(['primary', 'secondary']),
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
  normalModelSlug: z.string().max(120).nullable(),
  rateLimitReachedType: z.string().max(120).nullable(),
  spendControlReached: z.boolean(),
}).strict();

export const CodexAccountCreditsDtoSchema = z.object({
  remaining: z.number().nonnegative().nullable(),
  currency: z.string().max(16).nullable(),
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
}).strict();

export const CodexAccountUsageDtoSchema = z.object({
  lifetimeTokens: z.number().int().nonnegative().nullable(),
  peakDailyTokens: z.number().int().nonnegative().nullable(),
  longestRunningTurnSec: z.number().int().nonnegative().nullable(),
  currentStreakDays: z.number().int().nonnegative().nullable(),
  longestStreakDays: z.number().int().nonnegative().nullable(),
  dailyUsageBuckets: z.array(z.object({ startDate: z.string().min(1).max(32), tokens: z.number().int().nonnegative() }).strict()).max(366),
}).strict();

export const WorkspaceSourceMetaDtoSchema = z.object({
  state: z.enum(['live', 'snapshot', 'failed_snapshot', 'unavailable']),
  lastSuccessAt: z.number().int().nonnegative().nullable(),
  lastAttemptAt: z.number().int().nonnegative().nullable(),
  error: z.string().max(160).nullable(),
}).strict();

export const CodexAccountSnapshotDtoSchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  status: z.enum(['ready', 'unavailable']),
  authMode: z.enum(['chatgpt', 'chatgptAuthTokens', 'apikey', 'amazonBedrock', 'unknown']),
  email: z.string().max(320).nullable(),
  planType: z.string().max(64).nullable(),
  rateLimits: z.array(CodexAccountRateLimitDtoSchema).max(20),
  credits: CodexAccountCreditsDtoSchema.nullable(),
  rateLimitResetCredits: z.object({
    availableCount: z.number().int().nonnegative(),
    credits: z.array(z.object({ id: z.string().max(256).nullable(), title: z.string().max(80).nullable(), expiresAt: z.number().int().nonnegative().nullable() }).strict()).max(20).nullable().optional(),
  }).strict().nullable(),
  usage: CodexAccountUsageDtoSchema.nullable(),
  errorMessage: z.string().max(160).nullable(),
  identityVerified: z.boolean().optional(),
  sourceMeta: WorkspaceSourceMetaDtoSchema.optional(),
}).strict();

export const CodexResetCreditResultDtoSchema = z.object({
  outcome: z.enum(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']),
}).strict();

export const MaintenanceOutputSnapshotDtoSchema = z.object({
  operationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lines: z.array(z.string().min(1).max(500).refine((line) => !/[\u0000-\u001f\u007f]/.test(line))).max(2),
  status: z.enum(['running', 'completed', 'failed']),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const EngineMaintenanceOperationDtoSchema = z.object({
  operationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  engineId: EngineIdSchema,
  action: EngineMaintenanceActionSchema,
  status: z.enum(['reserved', 'processing', 'completed', 'failed']),
  message: z.string().min(1).max(300),
  stalled: z.boolean().optional(),
  retryAfterMs: z.number().int().nonnegative().max(3_600_000),
  output: MaintenanceOutputSnapshotDtoSchema.nullable(),
}).strict();

export const ShareScopeSchema = z.enum(['single', 'selection', 'session']);
export const ShareManagementStatusSchema = z.enum(['active', 'expired', 'revoked']);
export const ShareExpirySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preset'), value: z.enum(['1h', '1d', '7d', '30d']) }).strict(),
  z.object({ type: z.literal('custom'), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('permanent') }).strict(),
]);

const ShareCreateBaseShape = {
  sessionId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  includeProcess: z.boolean(),
  expiry: ShareExpirySchema,
};

export const CreateShareRequestSchema = z.discriminatedUnion('scope', [
  z.object({ ...ShareCreateBaseShape, scope: z.literal('single'), messageIds: z.array(z.string().uuid()).max(200) }).strict(),
  z.object({ ...ShareCreateBaseShape, scope: z.literal('selection'), messageIds: z.array(z.string().uuid()).max(200) }).strict(),
  z.object({ ...ShareCreateBaseShape, scope: z.literal('session') }).strict(),
]);

export const ShareSnapshotMessageSchema = z.object({
  id: z.string(),
  turnId: z.string().optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.number(),
  duration: z.number().nullable().optional(),
  outcome: MessageOutcomeSchema.optional(),
  processContent: z.string().optional(),
  processItems: z.array(ProcessItemDtoSchema).optional(),
  processTimeline: z.array(ProcessTimelineEntrySchema).optional(),
  changedFiles: z.array(ChangedFileDtoSchema).max(500).optional(),
  changedFilesIncomplete: z.boolean().optional(),
  attachments: z.array(MessageAttachmentSummaryDtoSchema).max(10).optional(),
  modelInfo: MessageModelInfoDtoSchema.optional(),
}).strict();

export const ShareSnapshotV1Schema = z.object({
  version: z.literal(1),
  scope: ShareScopeSchema.optional(),
  includeProcess: z.boolean().optional(),
  sourceEngine: EngineIdSchema.optional(),
  messages: z.array(ShareSnapshotMessageSchema),
}).strict();

export const ShareListItemDtoSchema = z.object({
  id: z.string(),
  publicToken: z.string(),
  title: z.string(),
  scope: ShareScopeSchema,
  messageCount: z.number().int().nonnegative(),
  assistantMessageCount: z.number().int().nonnegative().optional(),
  includeProcess: z.boolean(),
  sourceSessionId: z.string().nullable(),
  sourceSessionTitle: z.string().nullable(),
  sourceState: z.enum(['available', 'deleted', 'unavailable']).optional(),
  sourceEngine: EngineIdSchema,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  revokedAt: z.number().int().nonnegative().nullable(),
  status: ShareManagementStatusSchema,
}).strict();

export const CreateShareResponseDtoSchema = z.object({
  id: z.string(),
  publicToken: z.string(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
}).strict();

export const SharePreviewResponseDtoSchema = z.object({
  title: z.string(),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  snapshot: ShareSnapshotV1Schema,
}).strict();

export const ShareListResponseDtoSchema = z.object({
  items: z.array(ShareListItemDtoSchema),
  total: z.number().int().nonnegative(),
}).strict();

export const PublicShareResponseDtoSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('active'),
    title: z.string(),
    messageCount: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
    snapshot: ShareSnapshotV1Schema,
  }).strict(),
  z.object({ state: z.literal('expired') }).strict(),
  z.object({ state: z.literal('revoked') }).strict(),
  z.object({ state: z.literal('not_found') }).strict(),
  z.object({ state: z.literal('unreadable') }).strict(),
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;
export type EngineId = z.infer<typeof EngineIdSchema>;
export type ReasoningOptionDto = z.infer<typeof ReasoningOptionDtoSchema>;
export type EngineModelDto = z.infer<typeof EngineModelDtoSchema>;
export type EngineModelCatalogDto = z.infer<typeof EngineModelCatalogDtoSchema>;
export type EnginePreferencesDto = z.infer<typeof EnginePreferencesDtoSchema>;
export type ApprovalTrustDuration = z.infer<typeof ApprovalTrustDurationSchema>;
export type ApprovalTrustMode = z.infer<typeof ApprovalTrustModeSchema>;
export type ApprovalTrustSettingDto = z.infer<typeof ApprovalTrustSettingDtoSchema>;
export type EffectiveApprovalTrustDto = z.infer<typeof EffectiveApprovalTrustDtoSchema>;
export type ApprovalTrustStateDto = z.infer<typeof ApprovalTrustStateDtoSchema>;
export type ApprovalDecisionSource = z.infer<typeof ApprovalDecisionSourceSchema>;
export type ApprovalDecisionScope = z.infer<typeof ApprovalDecisionScopeSchema>;
export type InteractionResolvedAction = z.infer<typeof InteractionResolvedActionSchema>;
export type PutProjectApprovalTrustRequest = z.infer<typeof PutProjectApprovalTrustRequestSchema>;
export type PutSessionApprovalTrustRequest = z.infer<typeof PutSessionApprovalTrustRequestSchema>;
export type ModelExecutionDescriptorDto = z.infer<typeof ModelExecutionDescriptorDtoSchema>;
export type RequestedModelExecutionDescriptorDto = z.infer<typeof RequestedModelExecutionDescriptorDtoSchema>;
export type MessageModelInfoDto = z.infer<typeof MessageModelInfoDtoSchema>;
export type ClientDiagnosticsDto = z.infer<typeof ClientDiagnosticsDtoSchema>;
export type ClientEnvironmentDto = z.infer<typeof ClientEnvironmentDtoSchema>;
export type MessageOriginDto = z.infer<typeof MessageOriginDtoSchema>;
export type EngineCapacityWindowDto = z.infer<typeof EngineCapacityWindowDtoSchema>;
export type EngineConcurrencyDto = z.infer<typeof EngineConcurrencyDtoSchema>;
export type TurnQueueSnapshotDto = z.infer<typeof TurnQueueSnapshotDtoSchema>;
export type SessionFollowupDto = z.infer<typeof SessionFollowupDtoSchema>;
export type SessionDto = z.infer<typeof SessionDtoSchema>;
export type SessionDetailsDto = z.infer<typeof SessionDetailsDtoSchema>;
export type SessionDeletionImpactDto = z.infer<typeof SessionDeletionImpactDtoSchema>;
export type ProjectDeletionImpactDto = z.infer<typeof ProjectDeletionImpactDtoSchema>;
export type TrashProjectDto = z.infer<typeof TrashProjectDtoSchema>;
export type TrashSessionDto = z.infer<typeof TrashSessionDtoSchema>;
export type TrashProjectListResponseDto = z.infer<typeof TrashProjectListResponseDtoSchema>;
export type TrashSessionListResponseDto = z.infer<typeof TrashSessionListResponseDtoSchema>;
export type TrashRestoreResponseDto = z.infer<typeof TrashRestoreResponseDtoSchema>;
export type TrashImpactDto = z.infer<typeof TrashImpactDtoSchema>;
export type TrashProjectDeleteRequest = z.infer<typeof TrashProjectDeleteRequestSchema>;
export type TrashSessionDeleteRequest = z.infer<typeof TrashSessionDeleteRequestSchema>;
export type TrashDeleteResponseDto = z.infer<typeof TrashDeleteResponseDtoSchema>;
export type SidebarOrderScope = z.infer<typeof SidebarOrderScopeSchema>;
export type SidebarOrderItemDto = z.infer<typeof SidebarOrderItemDtoSchema>;
export type SidebarOrderDto = z.infer<typeof SidebarOrderDtoSchema>;
export type SidebarOrdersResponseDto = z.infer<typeof SidebarOrdersResponseDtoSchema>;
export type MoveSidebarOrderRequest = z.infer<typeof MoveSidebarOrderRequestSchema>;
export type MoveSidebarOrderResponseDto = z.infer<typeof MoveSidebarOrderResponseDtoSchema>;
export type PublicUserDto = z.infer<typeof PublicUserDtoSchema>;
export type UserResponseDto = z.infer<typeof UserResponseDtoSchema>;
export type UserListResponseDto = z.infer<typeof UserListResponseDtoSchema>;
export type PendingApprovalKind = z.infer<typeof PendingApprovalKindSchema>;
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;
export type PendingApprovalResolution = z.infer<typeof PendingApprovalResolutionSchema>;
export type PendingApprovalDto = z.infer<typeof PendingApprovalDtoSchema>;
export type ProcessItemStatus = z.infer<typeof ProcessItemStatusSchema>;
export type ExecutionStage = z.infer<typeof ExecutionStageSchema>;
export type MessageOutcome = z.infer<typeof MessageOutcomeSchema>;
export type ChangedFileType = z.infer<typeof ChangedFileTypeSchema>;
export type ChangedFileDto = z.infer<typeof ChangedFileDtoSchema>;
export type HostFileAttachmentDto = z.infer<typeof HostFileAttachmentDtoSchema>;
export type AuthorizedHostFileAttachmentDto = z.infer<typeof AuthorizedHostFileAttachmentDtoSchema>;
export type HostFileAttachmentSummaryDto = z.infer<typeof HostFileAttachmentSummaryDtoSchema>;
export type UploadedFileDraftDto = z.infer<typeof UploadedFileDraftDtoSchema>;
export type UploadedFileAttachmentDto = z.infer<typeof UploadedFileAttachmentDtoSchema>;
export type UploadedFileAttachmentSummaryDto = z.infer<typeof UploadedFileAttachmentSummaryDtoSchema>;
export type MessageAttachmentDto = z.infer<typeof MessageAttachmentDtoSchema>;
export type SendAttachmentDto = z.infer<typeof SendAttachmentDtoSchema>;
export type MessageAttachmentSummaryDto = z.infer<typeof MessageAttachmentSummaryDtoSchema>;
export type ProcessItemDto = z.infer<typeof ProcessItemDtoSchema>;
export type ProcessTimelineEntryDto = z.infer<typeof ProcessTimelineEntrySchema>;
export type MessageDto = z.infer<typeof MessageDtoSchema>;
export type MessageSummaryDto = z.infer<typeof MessageSummaryDtoSchema>;
export type MessageDetailsDto = z.infer<typeof MessageDetailsDtoSchema>;
export type SubAgentReportDto = z.infer<typeof SubAgentReportDtoSchema>;
export type MessageCursorDto = z.infer<typeof MessageCursorDtoSchema>;
export type MessagePageDto = z.infer<typeof MessagePageDtoSchema>;
export type MessagePageResultDto = z.infer<typeof MessagePageResultDtoSchema>;
export type UsageDto = z.infer<typeof UsageDtoSchema>;
export type TokenUsageDto = z.infer<typeof TokenUsageDtoSchema>;
export type ApiErrorDto = z.infer<typeof ApiErrorDtoSchema>;
export type OkDto = z.infer<typeof OkDtoSchema>;
export type AuthResponseDto = z.infer<typeof AuthResponseDtoSchema>;
export type NotificationPreferencesDto = z.infer<typeof NotificationPreferencesDtoSchema>;
export type NotificationPreferencesResponseDto = z.infer<typeof NotificationPreferencesResponseDtoSchema>;
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;
export type ThemeProfileDto = z.infer<typeof ThemeProfileDtoSchema>;
export type AccountThemeSettingsDto = z.infer<typeof AccountThemeSettingsDtoSchema>;
export type ThemeSettingsV1 = z.infer<typeof ThemeSettingsV1Schema>;
export type ThemeSettingsInput = z.infer<typeof ThemeSettingsInputSchema>;
export type AccountThemeSettingsResponseDto = z.infer<typeof AccountThemeSettingsResponseDtoSchema>;
export type ThemeAssetResponseDto = z.infer<typeof ThemeAssetResponseDtoSchema>;
export type SessionUpdateResponseDto = z.infer<typeof SessionUpdateResponseDtoSchema>;
export type MessageSearchSnippetDto = z.infer<typeof MessageSearchSnippetDtoSchema>;
export type SessionMessageMatchDto = z.infer<typeof SessionMessageMatchDtoSchema>;
export type SessionSearchResultDto = z.infer<typeof SessionSearchResultDtoSchema>;
export type SessionSearchResponseDto = z.infer<typeof SessionSearchResponseDtoSchema>;
export type SessionMessageMatchesResponseDto = z.infer<typeof SessionMessageMatchesResponseDtoSchema>;
export type FileAccessResponseDto = z.infer<typeof FileAccessResponseDtoSchema>;
export type ArchiveEntryDto = z.infer<typeof ArchiveEntryDtoSchema>;
export type ArchivePreviewDto = z.infer<typeof ArchivePreviewDtoSchema>;
export type PdfDocumentPreviewDto = z.infer<typeof PdfDocumentPreviewDtoSchema>;
export type WordDocumentPreviewDto = z.infer<typeof WordDocumentPreviewDtoSchema>;
export type SpreadsheetCellDto = z.infer<typeof SpreadsheetCellDtoSchema>;
export type SpreadsheetRowDto = z.infer<typeof SpreadsheetRowDtoSchema>;
export type SpreadsheetSheetSummaryDto = z.infer<typeof SpreadsheetSheetSummaryDtoSchema>;
export type SpreadsheetSheetPreviewDto = z.infer<typeof SpreadsheetSheetPreviewDtoSchema>;
export type SpreadsheetDocumentPreviewDto = z.infer<typeof SpreadsheetDocumentPreviewDtoSchema>;
export type SpreadsheetSheetResponseDto = z.infer<typeof SpreadsheetSheetResponseDtoSchema>;
export type HostFileAuthorizationResponseDto = z.infer<typeof HostFileAuthorizationResponseDtoSchema>;
export type ProjectUploadUsageDto = z.infer<typeof ProjectUploadUsageDtoSchema>;
export type ProjectUploadResponseDto = z.infer<typeof ProjectUploadResponseDtoSchema>;
export type ProjectUploadedFileDto = z.infer<typeof ProjectUploadedFileDtoSchema>;
export type ProjectUploadsResponseDto = z.infer<typeof ProjectUploadsResponseDtoSchema>;
export type ProjectUploadDeleteResponseDto = z.infer<typeof ProjectUploadDeleteResponseDtoSchema>;
export type ProjectUploadCleanupPendingDto=z.infer<typeof ProjectUploadCleanupPendingDtoSchema>;

export type CodexVersionDto = z.infer<typeof CodexVersionDtoSchema>;
export type ReleaseOverviewTopic = z.infer<typeof ReleaseOverviewTopicSchema>;
export type ReleaseOverviewDto = z.infer<typeof ReleaseOverviewDtoSchema>;
export type EngineCapabilitiesDto = z.infer<typeof EngineCapabilitiesDtoSchema>;
export type EngineStatusDto = z.infer<typeof EngineStatusDtoSchema>;
export type EngineStatusResponseDto = z.infer<typeof EngineStatusResponseDtoSchema>;
export type SystemResourceStatusDto = z.infer<typeof SystemResourceStatusDtoSchema>;
export type EngineMaintenanceAction = z.infer<typeof EngineMaintenanceActionSchema>;
export type EngineMaintenanceInstallSource = z.infer<typeof EngineMaintenanceInstallSourceSchema>;
export type EngineMaintenanceReadiness = z.infer<typeof EngineMaintenanceReadinessSchema>;
export type EngineMaintenanceLatestCheckStatus = z.infer<typeof EngineMaintenanceLatestCheckStatusSchema>;
export type EngineInstanceVersionDto = z.infer<typeof EngineInstanceVersionDtoSchema>;
export type EngineMaintenanceActionDto = z.infer<typeof EngineMaintenanceActionDtoSchema>;
export type EngineMaintenanceStatusDto = z.infer<typeof EngineMaintenanceStatusDtoSchema>;
export type EngineMaintenanceResponseDto = z.infer<typeof EngineMaintenanceResponseDtoSchema>;
export type CodexAccountRateLimitDto = z.infer<typeof CodexAccountRateLimitDtoSchema>;
export type CodexAccountCreditsDto = z.infer<typeof CodexAccountCreditsDtoSchema>;
export type CodexAccountUsageDto = z.infer<typeof CodexAccountUsageDtoSchema>;
export type CodexAccountSnapshotDto = z.infer<typeof CodexAccountSnapshotDtoSchema>;
export type MaintenanceOutputSnapshotDto = z.infer<typeof MaintenanceOutputSnapshotDtoSchema>;
export type EngineMaintenanceOperationDto = z.infer<typeof EngineMaintenanceOperationDtoSchema>;
export type ShareScope = z.infer<typeof ShareScopeSchema>;
export type ShareManagementStatus = z.infer<typeof ShareManagementStatusSchema>;
export type ShareExpiry = z.infer<typeof ShareExpirySchema>;
export type CreateShareRequest = z.infer<typeof CreateShareRequestSchema>;
export type ShareSnapshotMessage = z.infer<typeof ShareSnapshotMessageSchema>;
export type ShareSnapshotV1 = z.infer<typeof ShareSnapshotV1Schema>;
export type ShareListItemDto = z.infer<typeof ShareListItemDtoSchema>;
export type CreateShareResponseDto = z.infer<typeof CreateShareResponseDtoSchema>;
export type SharePreviewResponseDto = z.infer<typeof SharePreviewResponseDtoSchema>;
export type ShareListResponseDto = z.infer<typeof ShareListResponseDtoSchema>;
export type PublicShareResponseDto = z.infer<typeof PublicShareResponseDtoSchema>;
type ProjectSource = {
  id: string;
  name: string;
  path: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  pinned_at?: number | null;
  is_system: number;
  deletion_protected?: number;
  access_role?: 'owner' | 'viewer' | 'collaborator' | 'manager';
  members_can_view_sessions?: number;
  session_count?: number;
};

type SessionSource = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  pinned_at?: number | null;
  project_id: string | null;
  engine: z.infer<typeof EngineIdSchema> | null;
  engine_bound?: number;
  codex_thread_id?: string | null;
  codex_archived: number;
  status: SessionStatus;
  last_result?: SessionDto['last_result'];
  message_revision?: number;
  message_count?: number;
  assistant_message_count?: number;
  context_compaction_count?: number;
  selected_model_id?: string | null;
  selected_reasoning_effort?: string | null;
  selected_service_tier?: string | null;
  engine_preferences_revision?: number;
};

type SessionDetailsSource = SessionSource & {
  engine_session_id: string | null;
};

type PublicUserSource = {
  id: string;
  username: string;
  display_name?: string | null;
  role: 'admin' | 'member';
  avatar_updated_at?: number | null;
  default_project_id?: string | null;
  default_engine?: EngineId;
  default_model_id?: string | null;
  must_change_password?: number | null;
  disabled_at?: number | null;
  can_create_project?: number;
};

export function presentResourceOwner(owner?: PublicUserSource | null) {
  return owner ? {
    id: owner.id,
    username: owner.username,
    displayName: owner.display_name?.trim() || owner.username,
    role: owner.role,
    avatarUpdatedAt: owner.avatar_updated_at ?? null,
  } : null;
}

export function presentProject<T extends ProjectSource>(project: T, owner?: PublicUserSource | null): ProjectDto {
  return ProjectDtoSchema.parse({
    id: project.id,
    name: project.name,
    path: project.path,
    created_at: project.created_at,
    updated_at: project.updated_at,
    pinned: project.pinned,
    pinned_at: project.pinned_at ?? null,
    is_system: project.is_system,
    deletion_protected: project.deletion_protected ?? 0,
    ...(project.access_role ? { access_role: project.access_role } : {}),
    members_can_view_sessions: project.members_can_view_sessions ?? 0,
    ...(project.session_count !== undefined ? { session_count: project.session_count } : {}),
    ...(owner !== undefined ? { owner: presentResourceOwner(owner) } : {}),
  });
}

export function presentSession<T extends SessionSource>(session: T, owner?: PublicUserSource | null): SessionDto {
  return SessionDtoSchema.parse({
    id: session.id,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    pinned: session.pinned,
    pinned_at: session.pinned_at ?? null,
    project_id: session.project_id,
    engine: session.engine,
    codex_archived: session.codex_archived === 1,
    can_fork: (session.engine === 'codex'
      && session.engine_bound === 1
      && Boolean(session.project_id)
      && Boolean(session.codex_thread_id)
      && (session.message_revision ?? 0) > 0
      && session.codex_archived !== 1)
      || (session.engine === 'zcode'
        && session.engine_bound === 1
        && Boolean(session.project_id)
        && Boolean((session as unknown as { engine_session_id?: string | null }).engine_session_id)
        && (session.message_revision ?? 0) > 0),
    status: session.status === 'idle' && session.last_result ? session.last_result.status : session.status,
    ...(session.last_result !== undefined ? { last_result: session.last_result } : {}),
    engine_preferences: {
      modelId: session.selected_model_id ?? null,
      reasoningEffort: session.selected_reasoning_effort ?? null,
      serviceTier: session.selected_service_tier ?? null,
      revision: Math.max(0, Math.trunc(session.engine_preferences_revision ?? 0)),
    },
    ...(session.message_count !== undefined ? { message_count: session.message_count } : {}),
    ...(session.assistant_message_count !== undefined ? { assistant_message_count: session.assistant_message_count } : {}),
    context_compaction_count: Math.max(0, Math.trunc(session.context_compaction_count ?? 0)),
    ...(owner !== undefined ? { owner: presentResourceOwner(owner) } : {}),
  });
}

export function presentSessionDetails<T extends SessionDetailsSource>(session: T, owner?: PublicUserSource | null): SessionDetailsDto {
  return SessionDetailsDtoSchema.parse({
    ...presentSession(session, owner),
    engine_session_id: session.engine_session_id,
  });
}

export function presentPublicUser<T extends PublicUserSource>(user: T): PublicUserDto {
  return PublicUserDtoSchema.parse({
    id: user.id,
    username: user.username,
    displayName: user.display_name?.trim() || user.username,
    role: user.role,
    avatarUpdatedAt: user.avatar_updated_at ?? null,
    defaultProjectId: user.default_project_id ?? null,
    defaultEngine: user.default_engine ?? 'codex',
    defaultModelId: user.default_model_id ?? null,
    mustChangePassword: user.must_change_password === 1,
    disabledAt: user.disabled_at ?? null,
    canCreateProject: user.role === 'admin' || user.can_create_project !== 0,
  });
}

export const WorkspaceConsoleDeliveryMatrixItemDtoSchema = z.object({ project: z.string().min(1), baseBranch: z.string().nullable(), featureBranch: z.string().nullable(), targetBranch: z.string().nullable(), revision: z.string().nullable(), source: z.string().min(1), verifiedAt: z.string().min(1) }).strict();
export const WorkspaceConsoleTaskDtoSchema = z.object({
  id: z.string().min(1), title: z.string().nullable(), taskPath: z.string().nullable(), taskDocumentPath: z.string().nullable(), status: z.string().nullable(),
  description: z.string().max(240).nullable().optional(),
  feishuPrimaryWorkItemId: z.string().regex(/^[1-9]\d*$/).nullable().optional(),
  horizon: z.string().nullable(), nextAction: z.string().nullable(), waitingOn: z.string().nullable(), statusBasis: z.string().nullable(),
  verification: z.string().nullable(), lastVerifiedAt: z.string().nullable(), startedAt: z.string().nullable(), completedAt: z.string().nullable(), deliveryMatrix: z.array(WorkspaceConsoleDeliveryMatrixItemDtoSchema).default([]), feishuWorkItemIds: z.array(z.string()), feishuWorkItemUrls: z.record(z.string(), z.string().url()).optional(),
}).strict();
export const WorkspaceConsoleRunDtoSchema = z.object({
  runId: z.string(), status: z.string(), taskId: z.string().nullable(), source: z.string(), mode: z.string().nullable(), target: z.string().nullable(),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(), durationSeconds: z.number().nonnegative().nullable(), exitCode: z.number().int().nullable(),
  committed: z.boolean().nullable(), insertedRows: z.number().int().nonnegative().nullable(), updatedRows: z.number().int().nonnegative().nullable(), summary: z.string(), evidenceFiles: z.array(z.string()),
  verification: z.object({ rowCount: z.number().int().nonnegative().nullable(), invalidDataStatusCount: z.number().int().nonnegative().nullable() }).strict().nullable(),
  executionLocation: z.enum(['local', 'remote']).nullable().optional(),
  serverName: z.string().nullable().optional(), observedAt: z.string().nullable().optional(), detailFilePath: z.string().nullable().optional(),
  resultMetrics: z.object({ source: z.enum(['progress', 'summary', 'status']), items: z.array(z.object({ label: z.string(), value: z.number().int().nonnegative(), kind: z.enum(['total', 'change', 'condition']) }).strict()) }).strict().nullable().optional(),
}).strict();
export const WorkspaceConsoleResponsibilityDtoSchema = z.object({
  reportKind: z.literal('project_responsibility'), sourceUserKey: z.string().min(1), todoEquivalent: z.literal(false),
  generatedAt: z.string().min(1), fetchedAt: z.number().int().nonnegative(),
  servedFromCache: z.boolean().optional(),
  complete: z.boolean(), stale: z.boolean(), error: z.string().nullable(),
  unverifiedCount: z.number().int().nonnegative().optional(),
  sourceMeta: WorkspaceSourceMetaDtoSchema.optional(),
  items: z.array(z.object({
    workItemId: z.string().regex(/^[1-9]\d*$/), title: z.string().min(1), typeName: z.string().nullable(),
    actionability: z.enum(['current', 'state_responsibility', 'upcoming']),
    statusName: z.string().min(1).nullable().optional(),
    myRoleKeys: z.array(z.string().min(1)).optional(), baseOwnerIsMe: z.boolean().optional(),
    fallbackContact: z.object({ role: z.enum(['reporter', 'creator']), names: z.array(z.string().min(1)).min(1) }).strict().optional(),
    updatedAt: z.string().datetime({ offset: true }).nullable().optional(),
    personalSubtasks: z.array(z.object({ id: z.string(), name: z.string(), passed: z.boolean() }).strict()),
    currentNodes: z.array(z.string()), version: z.string().nullable(), url: z.string().url().nullable(),
    localTaskIds: z.array(z.string()), linkedStoryIds: z.array(z.string().regex(/^[1-9]\d*$/)).optional(),
  }).strict()),
  workbenchItems: z.array(z.object({
    workItemId: z.string().regex(/^[1-9]\d*$/), title: z.string().min(1), typeName: z.string().nullable(),
    url: z.string().url().nullable(), ownerUserKey: z.string().min(1).nullable(),
    roleOwnerUserKeys: z.array(z.string().min(1)).optional(),
    stateKey: z.string().nullable(), isArchivedState: z.boolean().nullable(),
    flowFinished: z.boolean().nullable(), currentNodeNames: z.array(z.string().min(1)),
    currentNodes: z.array(z.object({ name: z.string().min(1), ownerNames: z.array(z.string().min(1)) }).strict()).optional(),
    myNodes: z.array(z.object({ id: z.string().min(1), name: z.string().min(1).nullable(),
      phase: z.enum(['current', 'upcoming', 'completed', 'unknown']), ownerCount: z.number().int().positive().nullable().optional() }).strict()).optional(),
    updatedAt: z.string().datetime({ offset: true }).nullable().optional(),
    finishedAt: z.string().datetime({ offset: true }).nullable().optional(),
    mySubtasks: z.array(z.object({
      id: z.string().regex(/^[1-9]\d*$/), title: z.string().min(1), owners: z.array(z.string().min(1)),
      passed: z.boolean(), nodeId: z.string().min(1), nodeName: z.string().min(1).nullable(), phase: z.enum(['current', 'upcoming', 'completed', 'unknown']),
      finishedAt: z.string().datetime({ offset: true }).nullable().optional(),
    }).strict()),
  }).strict()),
  localAssociated: z.array(z.object({
    associationKey: z.string().min(1), workItemId: z.string().regex(/^[1-9]\d*$/), title: z.string().min(1),
    url: z.string().url().nullable(), localTaskIds: z.array(z.string()),
  }).strict()),
  counts: z.object({ current: z.number().int().nonnegative(), stateResponsibility: z.number().int().nonnegative(), upcoming: z.number().int().nonnegative() }).strict(),
}).strict();
export const WorkspaceOperationRecordsDtoSchema = z.object({
  parentId: z.string().regex(/^[1-9]\d*$/), rangeStart: z.string().datetime({ offset: true }),
  rangeEnd: z.string().datetime({ offset: true }),
  hasMore: z.boolean(), cursor: z.string().nullable(),
  events: z.array(z.object({ at: z.string().datetime({ offset: true }),
    childId: z.string().regex(/^[1-9]\d*$/).nullable(), label: z.string().min(1).max(80) }).strict()).max(1000),
}).strict();
export const WorkspaceConsoleSessionCandidateDtoSchema = z.object({
  sessionId: z.string(), title: z.string(), projectPath: z.string(), updatedAt: z.number(), status: z.string(), url: z.string(),
  engine: z.string().nullable(), modelId: z.string().nullable(), latestMessage: z.string().nullable(),
  feishuWorkItemIds: z.array(z.string().regex(/^[1-9]\d*$/)).optional(),
}).strict();
export const WorkspaceConsoleDashboardDtoSchema = z.object({
  workspacePath: z.string(), capturedAt: z.number().int().nonnegative(), registryGeneratedAt: z.string().nullable(),
  counts: z.object({ total: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), active: z.number().int().nonnegative(), runs: z.number().int().nonnegative(), sessions: z.number().int().nonnegative() }).strict(),
  tasks: z.array(WorkspaceConsoleTaskDtoSchema.extend({ runIds: z.array(z.string()), sessionIds: z.array(z.string()), observedDurationSeconds: z.number().int().nonnegative().nullable() }).strict()),
  runs: z.array(WorkspaceConsoleRunDtoSchema), unmatchedRuns: z.array(WorkspaceConsoleRunDtoSchema),
  sessions: z.array(WorkspaceConsoleSessionCandidateDtoSchema), unlinkedSessions: z.array(WorkspaceConsoleSessionCandidateDtoSchema),
  errors: z.array(z.string()),
  sourceAvailable: z.object({ registry: z.boolean(), runs: z.boolean(), sessions: z.boolean(), links: z.boolean(), activity: z.boolean() }).strict(),
  sourceMeta: WorkspaceSourceMetaDtoSchema.optional(),
}).strict();
export const WorkspaceTaskSessionLinkResponseDtoSchema = z.object({ taskId: z.string().min(1), sessionId: z.string().min(1), linked: z.boolean() }).strict();
