// 此文件由 server/scripts/generate-client-contracts.ts 自动生成。
// 请勿手工修改；运行 npm run contracts:generate 更新。

export const RELAY_PROTOCOL_VERSION = 35 as const;

export type SessionStatus = 'idle' | 'queued' | 'pending' | 'processing' | 'recovering' | 'awaiting_action' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export type EngineId = 'codex' | 'codebuddy' | 'opencode' | 'zcode';

export interface ReasoningOptionDto {
  id: string;
  label: string;
  description?: string;
}

export interface EngineModelDto {
  id: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
  inputModalities: ('text' | 'image')[];
  contextWindow?: number;
  costLabel?: string;
  serviceTiers?: {
    id: string;
    label: string;
  }[];
  defaultServiceTier?: string;
  reasoning: {
    supported: boolean;
    scope: 'model' | 'session';
    defaultOptionId?: string;
    options: ReasoningOptionDto[];
  };
}

export interface EngineModelCatalogDto {
  engineId: EngineId;
  fetchedAt: number;
  stale: boolean;
  configurationRead?: boolean;
  models: EngineModelDto[];
  configuredDefaults?: {
    modelId?: string;
    reasoningEffort?: string;
    serviceTier?: string;
  };
}

export interface EnginePreferencesDto {
  modelId: string | null;
  reasoningEffort: string | null;
  serviceTier?: string | null;
  revision: number;
}

export type ApprovalTrustDuration = 'one_hour' | 'eight_hours' | 'permanent';

export type ApprovalTrustMode = 'trusted' | 'manual';

export type ApprovalDecisionSource = 'user' | 'session_trust' | 'project_trust' | 'resolved_elsewhere';

export type ApprovalDecisionScope = 'session' | 'project';

export type InteractionResolvedAction = 'accept' | 'accept_for_session' | 'decline' | 'cancel' | 'submit' | 'submitted' | 'resolved_elsewhere';

export interface ApprovalTrustSettingDto {
  scope: 'project' | 'session';
  mode: 'trusted' | 'manual';
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EffectiveApprovalTrustDto {
  trusted: boolean;
  source: 'manual' | 'session_trust' | 'project_trust';
  effectiveScope: 'session' | 'project' | null;
  expiresAt: number | null;
  sessionOverridesProject: boolean;
  diagnostic: 'scope_unavailable' | 'read_failed' | null;
}

export interface ApprovalTrustStateDto {
  projectSetting: ApprovalTrustSettingDto | null;
  sessionSetting: ApprovalTrustSettingDto | null;
  effective: EffectiveApprovalTrustDto;
}

export interface PutProjectApprovalTrustRequest {
  duration: 'one_hour' | 'eight_hours' | 'permanent';
}

export interface PutSessionApprovalTrustRequest {
  mode: 'trusted' | 'manual';
  duration: 'one_hour' | 'eight_hours' | 'permanent';
}

export interface ModelExecutionDescriptorDto {
  id: string;
  displayName: string;
  reasoningEffort?: string;
  provider?: string;
}

export interface RequestedModelExecutionDescriptorDto {
  id: string;
  displayName?: string;
  reasoningEffort?: string;
}

export interface MessageModelInfoDto {
  engineId: EngineId;
  requested?: RequestedModelExecutionDescriptorDto;
  effective: ModelExecutionDescriptorDto;
  serviceTier?: string | null;
  resolvedServiceTier?: string | null;
  rerouted: boolean;
}

export interface ClientDiagnosticsDto {
  capturedAt: number;
  userAgent: string;
  appVersion?: string;
  platform?: string;
  vendor?: string;
  language?: string;
  languages?: string[];
  timezone?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
  cookieEnabled?: boolean;
  doNotTrack?: string;
  webdriver?: boolean;
  pdfViewerEnabled?: boolean;
  standalone: boolean;
  online?: boolean;
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
    brands?: {
      brand: string;
      version: string;
    }[];
    highEntropy?: {
      architecture?: string;
      bitness?: string;
      formFactors?: string[];
      fullVersionList?: {
        brand: string;
        version: string;
      }[];
      model?: string;
      platformVersion?: string;
      uaFullVersion?: string;
      wow64?: boolean;
    };
  };
  screen?: {
    width?: number;
    height?: number;
    availWidth?: number;
    availHeight?: number;
    colorDepth?: number;
    pixelDepth?: number;
    devicePixelRatio?: number;
    orientationType?: string;
    orientationAngle?: number;
  };
  viewport?: {
    width?: number;
    height?: number;
    outerWidth?: number;
    outerHeight?: number;
    visualWidth?: number;
    visualHeight?: number;
    visualScale?: number;
    visualOffsetLeft?: number;
    visualOffsetTop?: number;
  };
  connection?: {
    type?: string;
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
  };
}

export interface ClientEnvironmentDto {
  source: 'web' | 'pwa';
  deviceType: 'desktop' | 'phone' | 'tablet';
  osName?: string;
  osVersion?: string;
  browserName?: string;
  browserVersion?: string;
  relayVersion: string;
}

export interface MessageOriginDto {
  senderUserId: string;
  senderUsername: string;
  senderDisplayName: string;
  ip: string;
  receivedAt: number;
  client?: ClientEnvironmentDto;
}

export type EngineMaintenanceAction = 'install' | 'restart' | 'upgrade' | 'upgrade_and_restart' | 'recheck';

export type ProcessItemStatus = 'in_progress' | 'completed' | 'incomplete';

export type ProcessTimelineEntryDto = {
  type: 'narrative';
  itemId: string;
  content: string;
  firstObservedAt?: number;
} | {
  type: 'operation';
  itemId: string;
};

export type ExecutionStage = 'accepted' | 'started' | 'responding';

export type MessageOutcome = 'completed' | 'failed' | 'stopped' | 'interrupted';

export type ChangedFileType = 'added' | 'modified' | 'deleted';

export type PendingApprovalKind = 'command_approval' | 'file_approval' | 'permissions_approval' | 'mcp_elicitation' | 'user_input' | 'async_question';

export type ApprovalAction = 'accept' | 'accept_for_session' | 'decline' | 'cancel';

export type PendingApprovalResolution = 'accept' | 'accept_for_session' | 'decline' | 'cancel' | 'submitted' | 'resolved_elsewhere' | 'invalidated';

export interface ProjectDto {
  id: string;
  name: string;
  path: string;
  created_at: number;
  updated_at: number;
  pinned: 0 | 1;
  pinned_at: number | null;
  is_system: 0 | 1;
  deletion_protected?: 0 | 1;
  access_role?: 'owner' | 'viewer' | 'collaborator' | 'manager';
  members_can_view_sessions?: 0 | 1;
  owner?: {
    id: string;
    username: string;
    displayName: string;
    role: 'admin' | 'member';
    avatarUpdatedAt: number | null;
  } | null;
}

export interface ProjectDeletionImpactDto {
  sessionCount: number;
  linkedCodexSessionCount: number;
  inProgressSessionCount: number;
}

export interface TrashProjectDto {
  id: string;
  name: string;
  path: string;
  deletedAt: number;
  sessionCount: number;
  matchSessionId?: string;
  matchSessionTitle?: string;
  matchSessionMessageCount?: number;
  matchMessageId?: string;
  matchCount?: number;
  matchSnippet?: string;
}

export interface TrashSessionDto {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  engine: EngineId | null;
  deletedAt: number;
  messageCount: number;
  matchMessageId?: string;
  matchCount?: number;
  matchSnippet?: string;
}

export interface TrashProjectListResponseDto {
  items: TrashProjectDto[];
  total: number;
  limit: number;
  offset: number;
}

export interface TrashSessionListResponseDto {
  items: TrashSessionDto[];
  total: number;
  limit: number;
  offset: number;
}

export interface TrashRestoreResponseDto {
  ok: true;
  restoredSessionCount: number;
  unarchivedSessionCount: number;
  unarchiveFailedSessionCount: number;
  archiveStateSyncFailedSessionCount: number;
}

export interface TrashImpactDto {
  sessionCount: number;
  messageCount: number;
  shareCount: number;
  attachmentCount: number;
  releasableBytes: number;
  impactRevision: string;
}

export interface TrashProjectDeleteRequest {
  impactRevision: string;
  confirmationName: string;
}

export interface TrashSessionDeleteRequest {
  impactRevision: string;
}

export interface TrashDeleteResponseDto {
  ok: true;
  cleanupPending: boolean;
}

export interface SessionDto {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  pinned: 0 | 1;
  pinned_at: number | null;
  project_id: string | null;
  engine: EngineId | null;
  codex_archived: boolean;
  can_fork: boolean;
  status: SessionStatus;
  last_result?: {
    messageId: string;
    turnId: string;
    status: 'completed' | 'failed' | 'stopped' | 'interrupted';
    createdAt: number;
    executionStage?: 'accepted' | 'started' | 'responding';
  } | null;
  pending_action_kind?: 'approval' | 'input' | 'mixed' | null;
  execution_stage?: 'accepted' | 'started' | 'responding' | null;
  engine_preferences: EnginePreferencesDto;
  message_count?: number;
  context_compaction_count?: number;
  owner?: {
    id: string;
    username: string;
    displayName: string;
    role: 'admin' | 'member';
    avatarUpdatedAt: number | null;
  } | null;
}

export interface SessionDetailsDto {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  pinned: 0 | 1;
  pinned_at: number | null;
  project_id: string | null;
  engine: EngineId | null;
  codex_archived: boolean;
  can_fork: boolean;
  status: SessionStatus;
  last_result?: {
    messageId: string;
    turnId: string;
    status: 'completed' | 'failed' | 'stopped' | 'interrupted';
    createdAt: number;
    executionStage?: 'accepted' | 'started' | 'responding';
  } | null;
  pending_action_kind?: 'approval' | 'input' | 'mixed' | null;
  execution_stage?: 'accepted' | 'started' | 'responding' | null;
  engine_preferences: EnginePreferencesDto;
  message_count?: number;
  context_compaction_count?: number;
  owner?: {
    id: string;
    username: string;
    displayName: string;
    role: 'admin' | 'member';
    avatarUpdatedAt: number | null;
  } | null;
  engine_session_id: string | null;
}

export interface SessionDeletionImpactDto {
  hasLinkedCodexThread: boolean;
}

export interface PublicUserDto {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  avatarUpdatedAt: number | null;
  defaultProjectId: string | null;
  defaultEngine: 'codex' | 'codebuddy' | 'opencode' | 'zcode';
  defaultModelId: string | null;
  mustChangePassword: boolean;
  disabledAt: number | null;
  canCreateProject?: boolean;
}

export interface PendingApprovalDto {
  id: string;
  sessionId: string;
  sessionTitle: string;
  engine: EngineId;
  kind: PendingApprovalKind;
  title: string;
  summary: string;
  details: Record<string, unknown>;
  availableActions: ApprovalAction[];
  createdAt: number;
}

export interface ProcessItemDto {
  id: string;
  type: string;
  status: ProcessItemStatus;
  details: Record<string, unknown>;
}

export interface ChangedFileDto {
  path: string;
  changeType: ChangedFileType;
  size?: number;
  external?: true;
}

export interface HostFileAttachmentDto {
  id: string;
  kind: 'host_file';
  name: string;
  path: string;
  size: number;
}

export interface AuthorizedHostFileAttachmentDto {
  id: string;
  kind: 'host_file';
  name: string;
  path: string;
  size: number;
  accessToken: string;
}

export interface HostFileAttachmentSummaryDto {
  id: string;
  kind: 'host_file';
  name: string;
  size: number;
}

export interface UploadedFileDraftDto {
  id: string;
  kind: 'uploaded_file';
  messageId: string;
  uploadId: string;
  projectId: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
}

export interface UploadedFileAttachmentDto {
  id: string;
  kind: 'uploaded_file';
  name: string;
  path: string;
  size: number;
  mimeType: string;
  available: boolean;
}

export interface UploadedFileAttachmentSummaryDto {
  id: string;
  kind: 'uploaded_file';
  name: string;
  size: number;
  mimeType: string;
  available: boolean;
}

export type MessageAttachmentDto = HostFileAttachmentDto | UploadedFileAttachmentDto;

export type SendAttachmentDto = AuthorizedHostFileAttachmentDto | UploadedFileDraftDto;

export type MessageAttachmentSummaryDto = HostFileAttachmentSummaryDto | UploadedFileAttachmentSummaryDto;

export interface MessageDto {
  requestTurnId?: string;
  replyToAsyncQuestionId?: string;
  id: string;
  session_id: string;
  turn_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  phase: string | null;
  created_at: number;
  duration: number | null;
  stopped: boolean;
  isError?: boolean;
  items?: ProcessItemDto[];
  processContent?: string;
  processTimeline?: ProcessTimelineEntryDto[];
  changedFiles?: ChangedFileDto[];
  changedFilesIncomplete?: boolean;
  executionStage?: ExecutionStage;
  outcome?: MessageOutcome;
  errorCode?: string;
  errorMessage?: string;
  tokenUsage?: TokenUsageDto;
  attachments?: MessageAttachmentDto[];
  modelInfo?: MessageModelInfoDto;
  origin?: MessageOriginDto;
}

export interface MessageDetailsDto {
  sessionId: string;
  messageId: string;
  items?: ProcessItemDto[];
  processContent?: string;
  processTimeline?: ProcessTimelineEntryDto[];
  changedFiles?: ChangedFileDto[];
  changedFilesIncomplete?: boolean;
}

export interface MessageSummaryDto {
  requestTurnId?: string;
  replyToAsyncQuestionId?: string;
  id: string;
  session_id: string;
  turn_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  phase: string | null;
  created_at: number;
  duration: number | null;
  stopped: boolean;
  isError?: boolean;
  changedFiles?: ChangedFileDto[];
  changedFilesIncomplete?: boolean;
  executionStage?: ExecutionStage;
  outcome?: MessageOutcome;
  errorCode?: string;
  errorMessage?: string;
  tokenUsage?: TokenUsageDto;
  attachments?: MessageAttachmentDto[];
  modelInfo?: MessageModelInfoDto;
  origin?: MessageOriginDto;
  historicalOperationRecord?: boolean;
  asyncQuestionIds?: string[];
  hasDetails: boolean;
  processItemCount: number;
  processNarrativeCount: number;
  changedFileCount: number;
}

export interface MessageCursorDto {
  beforeCreatedAt: number;
  beforeId: string;
}

export interface MessagePageDto {
  sessionId: string;
  revision: number;
  hasMore: boolean;
  nextCursor: MessageCursorDto | null;
  messages: MessageSummaryDto[];
}

export type MessagePageResultDto = {
  unchanged: true;
  revision: number;
} | {
  unchanged: false;
  page: MessagePageDto;
};

export interface UsageDto {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TokenUsageDto {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  modelContextWindow: number | null;
}

export interface ApiErrorDto {
  error: string;
  code?: string;
  canForceAccess?: boolean;
  projectInTrash?: {
    id: string;
    name: string;
    sessionCount: number;
  };
}

export interface OkDto {
  ok: true;
}

export interface AuthResponseDto {
  user: PublicUserDto;
  expiresAt?: number;
}

export interface UserResponseDto {
  user: PublicUserDto;
}

export interface UserListResponseDto {
  users: PublicUserDto[];
}

export interface NotificationPreferencesDto {
  desktopSystemEnabled: boolean;
  desktopSoundEnabled: boolean;
  desktopSessionEndSystemEnabled: boolean;
  desktopSessionEndSoundEnabled: boolean;
  mobileSystemEnabled: boolean;
  mobileSoundEnabled: boolean;
  mobileSessionEndSystemEnabled: boolean;
  mobileSessionEndSoundEnabled: boolean;
  approvalSound: 'gentle_dual' | 'crisp' | 'soft_chime' | 'short_tone' | 'high_dual' | 'rising_triple' | 'falling_low';
  sessionEndSound: 'gentle_dual' | 'crisp' | 'soft_chime' | 'short_tone' | 'high_dual' | 'rising_triple' | 'falling_low';
  desktopSoundVolume: number;
  mobileSoundVolume: number;
}

export interface NotificationPreferencesResponseDto {
  preferences: NotificationPreferencesDto;
}

export type ThemePreference = 'light' | 'dark' | 'system';

export interface ThemeProfileDto {
  backgroundKind: 'none' | 'preset' | 'asset';
  backgroundValue: string | null;
  blur: number;
  fit: 'cover' | 'contain';
  position: 'center' | 'top' | 'bottom' | 'left' | 'right';
  overlayColor: string;
  overlayOpacity: number;
  panelOpacity: number;
  glassBlur: number;
  borderStrength: number;
}

export interface AccountThemeSettingsDto {
  version: 2;
  basePreference: ThemePreference;
  colorStyle: 'neutral' | 'aurora';
  textScale: 'compact' | 'standard' | 'large';
  linkedProfiles: boolean;
  desktop: ThemeProfileDto;
  mobile: ThemeProfileDto;
  updatedAt: number;
}

export interface AccountThemeSettingsResponseDto {
  settings: AccountThemeSettingsDto;
}

export interface ThemeAssetResponseDto {
  assetId: string;
}

export interface SessionUpdateResponseDto {
  ok: true;
  session: SessionDto;
}

export interface MessageSearchSnippetDto {
  text: string;
  matchStart: number;
  matchLength: number;
}

export interface SessionMessageMatchDto {
  messageId: string;
  role: 'user' | 'assistant';
  createdAt: number;
  scope: 'message' | 'process' | 'operation';
  itemId?: string;
  snippet: MessageSearchSnippetDto;
}

export interface SessionSearchResultDto {
  session: SessionDto;
  titleMatched: boolean;
  messageMatchCount: number;
  latestMessageMatch: SessionMessageMatchDto | null;
}

export interface SessionSearchResponseDto {
  query: string;
  results: SessionSearchResultDto[];
}

export interface SessionMessageMatchesResponseDto {
  query: string;
  total: number;
  truncated: boolean;
  matches: SessionMessageMatchDto[];
}

export interface FileAccessResponseDto {
  ok: true;
  accessToken: string;
}

export interface PdfDocumentPreviewDto {
  type: 'pdf-document';
  totalPages: number;
  displayedPages: number;
  truncated: boolean;
  size: number;
}

export interface WordDocumentPreviewDto {
  type: 'word-document';
  html: string;
  countUnit: 'pages' | 'blocks';
  totalCount: number;
  displayedCount: number;
  truncated: boolean;
  imageCount: number;
  omittedImageCount: number;
  size: number;
}

export interface SpreadsheetCellDto {
  column: number;
  address: string;
  display: string;
  formula?: string;
}

export interface SpreadsheetRowDto {
  rowNumber: number;
  cells: SpreadsheetCellDto[];
}

export interface SpreadsheetSheetSummaryDto {
  name: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  totalRows: number;
  totalColumns: number;
}

export interface SpreadsheetSheetPreviewDto {
  name: string;
  totalRows: number;
  totalColumns: number;
  displayedRows: number;
  displayedColumns: number;
  rowsTruncated: boolean;
  columnsTruncated: boolean;
  rows: SpreadsheetRowDto[];
  merges: string[];
}

export interface SpreadsheetDocumentPreviewDto {
  type: 'spreadsheet';
  sheets: SpreadsheetSheetSummaryDto[];
  activeSheet: SpreadsheetSheetPreviewDto;
  size: number;
}

export interface SpreadsheetSheetResponseDto {
  sheet: SpreadsheetSheetPreviewDto;
}

export interface HostFileAuthorizationResponseDto {
  attachments: AuthorizedHostFileAttachmentDto[];
}

export interface ProjectUploadUsageDto {
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  archivedFileCount: number;
  temporaryFileCount: number;
}

export interface ProjectUploadResponseDto {
  attachment: UploadedFileDraftDto;
  usage: ProjectUploadUsageDto;
}

export interface ProjectUploadedFileDto {
  id: string;
  kind: 'uploaded_file';
  name: string;
  size: number;
  mimeType: string;
  available: boolean;
  createdAt: number;
}

export interface ProjectUploadsResponseDto {
  usage: ProjectUploadUsageDto;
  files: ProjectUploadedFileDto[];
  cleanupBlockedReason: string | null;
}

export interface ProjectUploadDeleteResponseDto {
  deletedCount: number;
  usage: ProjectUploadUsageDto;
}

export interface ProjectUploadCleanupPendingDto {
  state: 'committed';
  deletedCount: number;
  cleanupPending: boolean;
  usagePending: true;
}

export interface CodexVersionDto {
  currentVersion: string | null;
  latestVersion: string | null;
  releaseOverview: {
    sourceStatus: 'available' | 'metadata_only' | 'unavailable' | 'unrecognized';
    counts: {
      features: number;
      improvements: number;
      fixes: number;
      documentation: number;
      chores: number;
    };
    topics: ('permissions_security' | 'mcp_extensions' | 'plugins_skills' | 'tasks_sessions' | 'multi_agent' | 'models_providers' | 'windows_cross_platform' | 'context_compaction' | 'connection_stability' | 'terminal_ui')[];
    officialSource: 'codex_github';
    officialUrl: string;
  } | null;
  releasePublishedAt?: number | null;
  updateAvailable: boolean | null;
  status: 'checking' | 'success' | 'error';
  checkedAt: number | null;
}
export interface EngineCapabilitiesDto {
  conversations: boolean;
  streaming: boolean;
  processItems: boolean;
  cancellation: boolean;
  interactions: boolean;
  tokenUsage: boolean;
  archive: boolean;
}
export interface EngineStatusDto {
  id: EngineId;
  label: string;
  ideInstalled: boolean;
  cliInstalled: boolean;
  processReady: boolean;
  protocolReady: boolean;
  available: boolean;
  availabilityStage: 'not_installed' | 'installed_auth_required' | 'protocol_incompatible' | 'readiness_stale' | 'readiness_failed' | 'ready';
  code: string;
  message: string;
  version: string | null;
  capabilities: EngineCapabilitiesDto;
}
export interface EngineStatusResponseDto {
  engines: EngineStatusDto[];
}
export interface SystemResourceStatusDto {
  available: boolean;
  level: 'normal' | 'warning' | 'critical' | 'unknown';
  committedBytes: number | null;
  commitLimitBytes: number | null;
  usagePercent: number | null;
  observedAt: number;
  warningThresholdPercent: number;
  criticalThresholdPercent: number;
  processMemory?: {
    relay: {
      privateBytes: number;
      backendPrivateBytes: number;
      processCount: number;
      scope: 'managed' | 'backend';
    } | null;
    topProcesses: {
      name: string;
      privateBytes: number;
      processCount: number;
    }[];
  } | null;
}
export interface EngineCapacityWindowDto {
  windowMinutes: 5 | 15 | 60;
  totalCount: number;
  overloadCount: number;
  requestRetryCount: number;
  completionRetryCount: number;
  cooldownCount: number;
  startAcceptedCount: number;
}
export interface EngineConcurrencyDto {
  resourceKey: string;
  engineId: EngineId;
  label: string;
  maxActiveTurns: number;
  activeTurns: number;
  queuedTurns: number;
  cooldownUntil: number | null;
  probeInProgress: boolean;
  windows: EngineCapacityWindowDto[];
}
export interface TurnQueueSnapshotDto {
  queueId: string;
  sessionId: string;
  engineId: EngineId;
  resourceKey: string;
  label: string;
  state: 'queued' | 'claimed';
  position: number | null;
  activeTurns: number;
  maxActiveTurns: number;
  cooldownUntil: number | null;
  createdAt: number;
}
export interface SessionFollowupDto {
  id: string;
  sessionId: string;
  content: string;
  attachments?: MessageAttachmentDto[];
  state: 'received' | 'steering' | 'steered' | 'queued' | 'dispatching' | 'delivered' | 'paused' | 'uncertain' | 'cancelled';
  createdAt: number;
  errorCode: string | null;
  replyToAsyncQuestionId: string | null;
}

export interface EngineInstanceVersionDto {
  version: string | null;
  count: number;
}

export interface EngineMaintenanceActionDto {
  action: 'install' | 'restart' | 'upgrade' | 'upgrade_and_restart' | 'recheck';
  label: string;
  enabled: boolean;
  reason: string | null;
  interruptsActiveTasks: boolean;
}

export interface EngineMaintenanceStatusDto {
  engineId: EngineId;
  label: string;
  installedVersion: string | null;
  installedAt: number | null;
  runningVersion: string | null;
  latestVersion: string | null;
  releaseOverview: {
    sourceStatus: 'available' | 'metadata_only' | 'unavailable' | 'unrecognized';
    counts: {
      features: number;
      improvements: number;
      fixes: number;
      documentation: number;
      chores: number;
    };
    topics: ('permissions_security' | 'mcp_extensions' | 'plugins_skills' | 'tasks_sessions' | 'multi_agent' | 'models_providers' | 'windows_cross_platform' | 'context_compaction' | 'connection_stability' | 'terminal_ui')[];
    officialSource: 'codex_github';
    officialUrl: string;
  } | {
    sourceStatus: 'available' | 'metadata_only' | 'unavailable' | 'unrecognized';
    counts: {
      features: number;
      improvements: number;
      fixes: number;
      documentation: number;
      chores: number;
    };
    topics: ('permissions_security' | 'mcp_extensions' | 'plugins_skills' | 'tasks_sessions' | 'multi_agent' | 'models_providers' | 'windows_cross_platform' | 'context_compaction' | 'connection_stability' | 'terminal_ui')[];
    officialSource: 'codebuddy_cnb';
    officialUrl: string;
  } | {
    sourceStatus: 'available' | 'metadata_only' | 'unavailable' | 'unrecognized';
    counts: {
      features: number;
      improvements: number;
      fixes: number;
      documentation: number;
      chores: number;
    };
    topics: ('permissions_security' | 'mcp_extensions' | 'plugins_skills' | 'tasks_sessions' | 'multi_agent' | 'models_providers' | 'windows_cross_platform' | 'context_compaction' | 'connection_stability' | 'terminal_ui')[];
    officialSource: 'zcode_changelog';
    officialUrl: string;
  } | null;
  releasePublishedAt?: number | null;
  updateAvailable: boolean | null;
  latestCheckStatus: 'idle' | 'checking' | 'success' | 'error';
  latestCheckedAt: number | null;
  installSource: 'official_npm_global' | 'desktop' | 'unknown';
  activeTaskCount: number;
  activeInstanceCount: number;
  instanceVersions: EngineInstanceVersionDto[];
  readiness: 'ready' | 'stale' | 'failed' | 'unknown';
  readinessCheckedAt: number | null;
  availabilityStage?: 'not_installed' | 'installed_auth_required' | 'protocol_incompatible' | 'readiness_stale' | 'readiness_failed' | 'ready' | 'install_failed';
  statusMessage?: string;
  loginCommand?: string | null;
  recommendedAction: 'install' | 'restart' | 'upgrade' | 'upgrade_and_restart' | 'recheck' | null;
  actions: EngineMaintenanceActionDto[];
}

export interface EngineMaintenanceResponseDto {
  engines: EngineMaintenanceStatusDto[];
}

export interface CodexAccountRateLimitDto {
  limitId: string;
  limitName: string | null;
  windowType: 'primary' | 'secondary';
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
  normalModelSlug: string | null;
  rateLimitReachedType: string | null;
  spendControlReached: boolean;
}

export interface CodexAccountCreditsDto {
  remaining: number | null;
  currency: string | null;
  hasCredits: boolean;
  unlimited: boolean;
}

export interface CodexAccountUsageDto {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  dailyUsageBuckets: {
    startDate: string;
    tokens: number;
  }[];
}

export interface CodexAccountSnapshotDto {
  fetchedAt: number;
  status: 'ready' | 'unavailable';
  authMode: 'chatgpt' | 'chatgptAuthTokens' | 'apikey' | 'amazonBedrock' | 'unknown';
  email: string | null;
  planType: string | null;
  rateLimits: CodexAccountRateLimitDto[];
  credits: CodexAccountCreditsDto | null;
  rateLimitResetCredits: {
    availableCount: number;
    credits?: {
      id: string | null;
      title: string | null;
      expiresAt: number | null;
    }[] | null;
  } | null;
  usage: CodexAccountUsageDto | null;
  errorMessage: string | null;
  identityVerified?: boolean;
  sourceMeta?: {
    state: 'live' | 'snapshot' | 'failed_snapshot' | 'unavailable';
    lastSuccessAt: number | null;
    lastAttemptAt: number | null;
    error: string | null;
  };
}

export interface CodexResetCreditResultDto {
  outcome: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
}

export interface MaintenanceOutputSnapshotDto {
  operationId: string;
  sequence: number;
  lines: string[];
  status: 'running' | 'completed' | 'failed';
  updatedAt: number;
}

export interface EngineMaintenanceOperationDto {
  operationId: string;
  engineId: EngineId;
  action: 'install' | 'restart' | 'upgrade' | 'upgrade_and_restart' | 'recheck';
  status: 'reserved' | 'processing' | 'completed' | 'failed';
  message: string;
  stalled?: boolean;
  retryAfterMs: number;
  output: MaintenanceOutputSnapshotDto | null;
}

export type SidebarOrderScope = 'projects' | 'pinned' | string;

export interface SidebarOrderItemDto {
  type: 'project' | 'session';
  id: string;
}

export interface SidebarOrderDto {
  scope: SidebarOrderScope;
  custom: boolean;
  items: SidebarOrderItemDto[];
}

export interface SidebarOrdersResponseDto {
  orders: SidebarOrderDto[];
}

export interface MoveSidebarOrderRequest {
  scope: SidebarOrderScope;
  item: SidebarOrderItemDto;
  before: SidebarOrderItemDto | null;
}

export interface MoveSidebarOrderResponseDto {
  order: SidebarOrderDto;
}

export interface WorkspaceConsoleTaskDto {
  id: string;
  title: string | null;
  taskPath: string | null;
  taskDocumentPath: string | null;
  status: string | null;
  description?: string | null;
  horizon: string | null;
  nextAction: string | null;
  waitingOn: string | null;
  statusBasis: string | null;
  verification: string | null;
  lastVerifiedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  deliveryMatrix: {
    project: string;
    baseBranch: string | null;
    featureBranch: string | null;
    targetBranch: string | null;
    revision: string | null;
    source: string;
    verifiedAt: string;
  }[];
  feishuWorkItemIds: string[];
  feishuWorkItemUrls?: Record<string, string>;
}

export interface WorkspaceConsoleRunDto {
  runId: string;
  status: string;
  taskId: string | null;
  source: string;
  mode: string | null;
  target: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  exitCode: number | null;
  committed: boolean | null;
  insertedRows: number | null;
  updatedRows: number | null;
  summary: string;
  evidenceFiles: string[];
  verification: {
    rowCount: number | null;
    invalidDataStatusCount: number | null;
  } | null;
  executionLocation?: 'local' | 'remote' | null;
  serverName?: string | null;
  observedAt?: string | null;
  detailFilePath?: string | null;
  resultMetrics?: {
    source: 'progress' | 'summary' | 'status';
    items: {
      label: string;
      value: number;
      kind: 'total' | 'change' | 'condition';
    }[];
  } | null;
}

export interface WorkspaceConsoleResponsibilityDto {
  reportKind: 'project_responsibility';
  sourceUserKey: string;
  todoEquivalent: false;
  generatedAt: string;
  fetchedAt: number;
  servedFromCache?: boolean;
  complete: boolean;
  stale: boolean;
  error: string | null;
  sourceMeta?: {
    state: 'live' | 'snapshot' | 'failed_snapshot' | 'unavailable';
    lastSuccessAt: number | null;
    lastAttemptAt: number | null;
    error: string | null;
  };
  items: {
    workItemId: string;
    title: string;
    typeName: string | null;
    actionability: 'current' | 'state_responsibility' | 'upcoming';
    statusName?: string | null;
    myRoleKeys?: string[];
    baseOwnerIsMe?: boolean;
    fallbackContact?: {
      role: 'reporter' | 'creator';
      names: string[];
    };
    updatedAt?: string | null;
    personalSubtasks: {
      id: string;
      name: string;
      passed: boolean;
    }[];
    currentNodes: string[];
    version: string | null;
    url: string | null;
    localTaskIds: string[];
    linkedStoryIds?: string[];
  }[];
  workbenchItems: {
    workItemId: string;
    title: string;
    typeName: string | null;
    url: string | null;
    ownerUserKey: string | null;
    roleOwnerUserKeys?: string[];
    stateKey: string | null;
    isArchivedState: boolean | null;
    flowFinished: boolean | null;
    currentNodeNames: string[];
    currentNodes?: {
      name: string;
      ownerNames: string[];
    }[];
    myNodes?: {
      id: string;
      name: string | null;
      phase: 'current' | 'upcoming' | 'completed' | 'unknown';
      ownerCount?: number | null;
    }[];
    updatedAt?: string | null;
    finishedAt?: string | null;
    mySubtasks: {
      id: string;
      title: string;
      owners: string[];
      passed: boolean;
      nodeId: string;
      nodeName: string | null;
      phase: 'current' | 'upcoming' | 'completed' | 'unknown';
      finishedAt?: string | null;
    }[];
  }[];
  localAssociated: {
    associationKey: string;
    workItemId: string;
    title: string;
    url: string | null;
    localTaskIds: string[];
  }[];
  counts: {
    current: number;
    stateResponsibility: number;
    upcoming: number;
  };
}

export interface WorkspaceOperationRecordsDto {
  parentId: string;
  rangeStart: string;
  rangeEnd: string;
  hasMore: boolean;
  cursor: string | null;
  events: {
    at: string;
    childId: string | null;
    label: string;
  }[];
}

export interface WorkspaceConsoleDashboardDto {
  workspacePath: string;
  capturedAt: number;
  registryGeneratedAt: string | null;
  counts: {
    total: number;
    completed: number;
    active: number;
    runs: number;
    sessions: number;
  };
  tasks: {
    id: string;
    title: string | null;
    taskPath: string | null;
    taskDocumentPath: string | null;
    status: string | null;
    description?: string | null;
    horizon: string | null;
    nextAction: string | null;
    waitingOn: string | null;
    statusBasis: string | null;
    verification: string | null;
    lastVerifiedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    deliveryMatrix: {
      project: string;
      baseBranch: string | null;
      featureBranch: string | null;
      targetBranch: string | null;
      revision: string | null;
      source: string;
      verifiedAt: string;
    }[];
    feishuWorkItemIds: string[];
    feishuWorkItemUrls?: Record<string, string>;
    runIds: string[];
    sessionIds: string[];
    observedDurationSeconds: number | null;
  }[];
  runs: WorkspaceConsoleRunDto[];
  unmatchedRuns: WorkspaceConsoleRunDto[];
  sessions: WorkspaceConsoleSessionCandidateDto[];
  unlinkedSessions: WorkspaceConsoleSessionCandidateDto[];
  errors: string[];
  sourceAvailable: {
    registry: boolean;
    runs: boolean;
    sessions: boolean;
    links: boolean;
    activity: boolean;
  };
  sourceMeta?: {
    state: 'live' | 'snapshot' | 'failed_snapshot' | 'unavailable';
    lastSuccessAt: number | null;
    lastAttemptAt: number | null;
    error: string | null;
  };
}

export interface WorkspaceConsoleSessionCandidateDto {
  sessionId: string;
  title: string;
  projectPath: string;
  updatedAt: number;
  status: string;
  url: string;
  engine: string | null;
  modelId: string | null;
  latestMessage: string | null;
  feishuWorkItemIds?: string[];
}

export interface WorkspaceTaskSessionLinkResponseDto {
  taskId: string;
  sessionId: string;
  linked: boolean;
}

export type ShareScope = 'single' | 'selection' | 'session';

export type ShareManagementStatus = 'active' | 'expired' | 'revoked';

export type ShareExpiry = {
  type: 'preset';
  value: '1h' | '1d' | '7d' | '30d';
} | {
  type: 'custom';
  expiresAt: number;
} | {
  type: 'permanent';
};

export type CreateShareRequest = {
  sessionId: string;
  title: string;
  includeProcess: boolean;
  expiry: {
    type: 'preset';
    value: '1h' | '1d' | '7d' | '30d';
  } | {
    type: 'custom';
    expiresAt: number;
  } | {
    type: 'permanent';
  };
  scope: 'single';
  messageIds: string[];
} | {
  sessionId: string;
  title: string;
  includeProcess: boolean;
  expiry: {
    type: 'preset';
    value: '1h' | '1d' | '7d' | '30d';
  } | {
    type: 'custom';
    expiresAt: number;
  } | {
    type: 'permanent';
  };
  scope: 'selection';
  messageIds: string[];
} | {
  sessionId: string;
  title: string;
  includeProcess: boolean;
  expiry: {
    type: 'preset';
    value: '1h' | '1d' | '7d' | '30d';
  } | {
    type: 'custom';
    expiresAt: number;
  } | {
    type: 'permanent';
  };
  scope: 'session';
};

export interface ShareSnapshotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  duration?: number | null;
  outcome?: MessageOutcome;
  processContent?: string;
  processItems?: ProcessItemDto[];
  processTimeline?: ProcessTimelineEntryDto[];
  changedFiles?: ChangedFileDto[];
  changedFilesIncomplete?: boolean;
  attachments?: MessageAttachmentSummaryDto[];
  modelInfo?: MessageModelInfoDto;
}

export interface ShareSnapshotV1 {
  version: 1;
  sourceEngine?: EngineId;
  messages: ShareSnapshotMessage[];
}

export interface ShareListItemDto {
  id: string;
  publicToken: string;
  title: string;
  scope: ShareScope;
  messageCount: number;
  includeProcess: boolean;
  sourceSessionId: string | null;
  sourceSessionTitle: string | null;
  sourceEngine: EngineId;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  status: ShareManagementStatus;
}

export interface CreateShareResponseDto {
  id: string;
  publicToken: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface SharePreviewResponseDto {
  title: string;
  messageCount: number;
  createdAt: number;
  expiresAt: number | null;
  snapshot: ShareSnapshotV1;
}

export interface ShareListResponseDto {
  items: ShareListItemDto[];
  total: number;
}

export type PublicShareResponseDto = {
  state: 'active';
  title: string;
  messageCount: number;
  createdAt: number;
  expiresAt: number | null;
  snapshot: ShareSnapshotV1;
} | {
  state: 'expired';
} | {
  state: 'revoked';
} | {
  state: 'not_found';
} | {
  state: 'unreadable';
};

export interface NewsPublicItemDto {
  id: string;
  eventId: string;
  sourceId: string;
  sourceName: string;
  url: string;
  title: string;
  description: string | null;
  publishedAt: number;
  categoryId: string;
  topicIds: string[];
  entityIds: string[];
  eventTypeId: string | null;
  language: string | null;
  originalPublisher: string | null;
  timeIsFallback: boolean;
}

export interface NewsPublicEventDto {
  id: string;
  eventId: string;
  sourceId: string;
  sourceName: string;
  url: string;
  title: string;
  description: string | null;
  publishedAt: number;
  categoryId: string;
  topicIds: string[];
  entityIds: string[];
  eventTypeId: string | null;
  language: string | null;
  originalPublisher: string | null;
  timeIsFallback: boolean;
  sources: NewsPublicItemDto[];
}

export interface NewsVersionDto {
  version: number;
  lastSuccessAt: number | null;
  partialFailure: boolean;
}

export interface NewsPublicPageDto {
  version: number;
  lastSuccessAt: number | null;
  partialFailure: boolean;
  items: NewsPublicEventDto[];
  nextCursor: string | null;
  categories: {
    id: string;
    label: string;
  }[];
  sources: {
    id: string;
    name: string;
  }[];
}

export interface NewsSourceConfigDto {
  id: string;
  name: string;
  kind: 'rss_atom' | 'github_releases' | 'hacker_news';
  url: string;
  allowedHosts: string[];
  enabled: boolean;
  intervalMinutes: number;
  categoryId: string;
  region?: 'cn' | 'global';
  disabledReason?: string;
}

export interface NewsSourceStateDto {
  sourceId: string;
  lastSuccessAt: number | null;
  lastCheckedAt: number | null;
  nextFetchAt: number | null;
  etag: string | null;
  lastModified: string | null;
  lastError: string | null;
  failureCount: number;
  lastDurationMs: number | null;
  lastFetchedCount: number | null;
}

export interface NewsAdminSourceDto {
  id: string;
  name: string;
  kind: 'rss_atom' | 'github_releases' | 'hacker_news';
  url: string;
  allowedHosts: string[];
  enabled: boolean;
  intervalMinutes: number;
  categoryId: string;
  region?: 'cn' | 'global';
  disabledReason?: string;
  state: {
    sourceId: string;
    lastSuccessAt: number | null;
    lastCheckedAt: number | null;
    nextFetchAt: number | null;
    etag: string | null;
    lastModified: string | null;
    lastError: string | null;
    failureCount: number;
    lastDurationMs: number | null;
    lastFetchedCount: number | null;
  } | null;
  totalItemCount: number;
}

export interface NewsAdminSourcesDto {
  sources: {
    id: string;
    name: string;
    kind: 'rss_atom' | 'github_releases' | 'hacker_news';
    url: string;
    allowedHosts: string[];
    enabled: boolean;
    intervalMinutes: number;
    categoryId: string;
    region?: 'cn' | 'global';
    disabledReason?: string;
    state: {
      sourceId: string;
      lastSuccessAt: number | null;
      lastCheckedAt: number | null;
      nextFetchAt: number | null;
      etag: string | null;
      lastModified: string | null;
      lastError: string | null;
      failureCount: number;
      lastDurationMs: number | null;
      lastFetchedCount: number | null;
    } | null;
    totalItemCount: number;
  }[];
}

export interface NewsGlobalPolicyDto {
  blockedDomains: string[];
  blockedKeywords: string[];
  blockedUrls: string[];
}

export interface NewsPolicyPreviewDto {
  matches: {
    id: string;
    title: string;
    reason: string;
  }[];
  capped: boolean;
}

export interface NewsPersonalRuleDto {
  id: string;
  kind: 'follow' | 'mute';
  category?: string;
  topic?: string;
  entity?: string;
  source?: string;
  eventType?: string;
}

export interface NewsPersonalPreferencesDto {
  rules: {
    id: string;
    kind: 'follow' | 'mute';
    category?: string;
    topic?: string;
    entity?: string;
    source?: string;
    eventType?: string;
  }[];
}

export interface NewsMemberEventDto {
  id: string;
  eventId: string;
  sourceId: string;
  sourceName: string;
  url: string;
  title: string;
  description: string | null;
  publishedAt: number;
  categoryId: string;
  topicIds: string[];
  entityIds: string[];
  eventTypeId: string | null;
  language: string | null;
  originalPublisher: string | null;
  timeIsFallback: boolean;
  sources: NewsPublicItemDto[];
  matchReason: string | null;
}

export interface NewsMemberPageDto {
  version: number;
  lastSuccessAt: number | null;
  partialFailure: boolean;
  nextCursor: string | null;
  categories: {
    id: string;
    label: string;
  }[];
  sources: {
    id: string;
    name: string;
  }[];
  items: {
    id: string;
    eventId: string;
    sourceId: string;
    sourceName: string;
    url: string;
    title: string;
    description: string | null;
    publishedAt: number;
    categoryId: string;
    topicIds: string[];
    entityIds: string[];
    eventTypeId: string | null;
    language: string | null;
    originalPublisher: string | null;
    timeIsFallback: boolean;
    sources: NewsPublicItemDto[];
    matchReason: string | null;
  }[];
  hasFollowRules: boolean;
}

export interface SubscribeCommand {
  type: 'subscribe';
  sessionId: string;
  active?: boolean;
  includeMessages?: boolean;
  deviceId?: string;
  resourceScope?: 'mine' | 'all';
  client?: {
    source: 'web' | 'pwa';
    deviceType: 'desktop' | 'phone' | 'tablet';
    osName?: string;
    osVersion?: string;
    browserName?: string;
    browserVersion?: string;
    relayVersion: string;
  };
}

export interface UnsubscribeCommand {
  type: 'unsubscribe';
  sessionId: string;
}

export interface SendCommand {
  type: 'send';
  sessionId: string;
  content: string;
  engine?: EngineId;
  enginePreferences?: EnginePreferencesDto;
  messageId?: string;
  workspaceTaskId?: string;
  replyToAsyncQuestionId?: string;
  attachments?: SendAttachmentDto[];
  client?: ClientEnvironmentDto;
  clientDiagnostics?: ClientDiagnosticsDto;
}

export interface CancelCommand {
  type: 'cancel';
  sessionId?: string;
}
export interface CancelFollowupCommand {
  type: 'cancel_followup';
  sessionId: string;
  messageId: string;
}
export interface ResumeFollowupsCommand {
  type: 'resume_followups';
  sessionId: string;
}

export interface RespondInteractionCommand {
  type: 'respond_interaction';
  operationId: string;
  sessionId: string;
  interactionId: string;
  action: 'accept' | 'accept_for_session' | 'decline' | 'cancel' | 'submit';
  answers?: Record<string, string[]>;
  formData?: Record<string, unknown>;
}

export interface MarkSessionReadCommand {
  type: 'mark_session_read';
  sessionId: string;
  messageId: string;
}
export type FrontendCommand = SubscribeCommand | UnsubscribeCommand | SendCommand | CancelCommand | CancelFollowupCommand | ResumeFollowupsCommand | RespondInteractionCommand | MarkSessionReadCommand;

export interface SyncStateEvent {
  type: 'sync_state';
  protocolVersion: 35;
  sessionId: string;
  messageRevision: number;
  messageHasMore: boolean;
  messageNextCursor: MessageCursorDto | null;
  messages: MessageSummaryDto[];
  isRunning: boolean;
  currentContent: string;
  processContent?: string;
  processSteps: ProcessItemDto[];
  processTimeline?: ProcessTimelineEntryDto[];
  startTime: number | null;
  requestForwarded: boolean;
  isStopping: boolean;
  queue?: TurnQueueSnapshotDto | null;
}

export interface RuntimeSyncStateEvent {
  type: 'runtime_sync_state';
  protocolVersion: 35;
  sessionId: string;
  isRunning: boolean;
  currentContent: string;
  processContent?: string;
  processSteps: ProcessItemDto[];
  processTimeline?: ProcessTimelineEntryDto[];
  startTime: number | null;
  requestForwarded: boolean;
  isStopping: boolean;
  queue?: TurnQueueSnapshotDto | null;
}

export interface ItemStartEvent {
  type: 'item_start';
  sessionId: string;
  item: ProcessItemDto;
}

export interface ItemCompleteEvent {
  type: 'item_complete';
  sessionId: string;
  item: ProcessItemDto;
}

export interface MessageSavedEvent {
  type: 'message_saved';
  sessionId: string;
  messageRevision: number;
  message: MessageDto;
}

export interface EngineConcurrencyUpdatedEvent {
  type: 'engine_concurrency_updated';
  concurrency: EngineConcurrencyDto;
}

export interface TurnQueueUpdatedEvent {
  type: 'turn_queue_updated';
  sessionId: string;
  queue: TurnQueueSnapshotDto | null;
}

export interface TurnQueueStartedEvent {
  type: 'turn_queue_started';
  sessionId: string;
  queueId: string;
}
export interface SessionFollowupSnapshotEvent {
  type: 'session_followup_snapshot';
  sessionId: string;
  followups: SessionFollowupDto[];
}
export interface SessionFollowupUpdatedEvent {
  type: 'session_followup_updated';
  sessionId: string;
  followup: SessionFollowupDto;
}

export type SharedFrontendEvent = SyncStateEvent | RuntimeSyncStateEvent | ItemStartEvent | ItemCompleteEvent | MessageSavedEvent | EngineConcurrencyUpdatedEvent | TurnQueueUpdatedEvent | TurnQueueStartedEvent | SessionFollowupSnapshotEvent | SessionFollowupUpdatedEvent;

export interface ProtocolInfoEvent {
  type: 'protocol_info';
  protocolVersion: 35;
}

export interface RequestForwardedEvent {
  type: 'request_forwarded';
  sessionId: string;
}

export interface TurnStartEvent {
  type: 'turn_start';
  sessionId: string;
  turnId: string;
}

export interface TurnCompleteEvent {
  type: 'turn_complete';
  sessionId: string;
  turnId: string;
}

export interface TurnCancellingEvent {
  type: 'turn_cancelling';
  sessionId: string;
}

export interface TurnCancelledEvent {
  type: 'turn_cancelled';
  sessionId: string;
}

export interface DeltaEvent {
  type: 'delta';
  sessionId: string;
  itemId: string;
  content: string;
  phase?: string;
  observedAt?: number;
}

export interface MessageCompleteEvent {
  type: 'message_complete';
  sessionId: string;
  turnId: string;
  content: string;
  processContent?: string;
  usage?: UsageDto | null;
}

export interface SessionUpdatedEvent {
  type: 'session_updated';
  sessionId: string;
  session: SessionDto;
  snapshot?: boolean;
}

export interface EnginePreferencesUpdatedEvent {
  type: 'engine_preferences_updated';
  sessionId: string;
  preferences: EnginePreferencesDto;
}

export interface SessionDeletionProgressEvent {
  type: 'session_deletion_progress';
  sessionId: string;
  stage: 'stopping' | 'archiving' | 'saving' | null;
}

export interface SessionDeletedEvent {
  type: 'session_deleted';
  sessionId: string;
}

export interface ProjectUpdatedEvent {
  type: 'project_updated';
  project: {
    id: string;
    name: string;
    path: string;
    created_at: number;
    updated_at: number;
    pinned: 0 | 1;
    pinned_at: number | null;
    is_system: 0 | 1;
    deletion_protected?: 0 | 1;
    access_role?: 'owner' | 'viewer' | 'collaborator' | 'manager';
    members_can_view_sessions?: 0 | 1;
    owner?: {
      id: string;
      username: string;
      displayName: string;
      role: 'admin' | 'member';
      avatarUpdatedAt: number | null;
    } | null;
  };
}

export interface ProjectDeletedEvent {
  type: 'project_deleted';
  projectId: string;
}

export interface ModelInfoEvent {
  type: 'model_info';
  sessionId: string;
  model: string;
  platformOs?: string;
  modelProvider?: string;
  reasoningEffort?: string;
}

export interface TokenUsageEvent {
  type: 'token_usage';
  sessionId: string;
  usage: TokenUsageDto;
  turnOutputUsage?: TokenUsageDto;
  currentTurn?: true;
}

export interface PendingApprovalsSnapshotEvent {
  type: 'pending_approvals_snapshot';
  approvals: PendingApprovalDto[];
  live?: boolean;
}

export interface PendingApprovalUpsertedEvent {
  type: 'pending_approval_upserted';
  approval: PendingApprovalDto;
}

export interface PendingApprovalResolvedEvent {
  type: 'pending_approval_resolved';
  sessionId: string;
  interactionId: string;
  resolvedAction: PendingApprovalResolution;
  item?: ProcessItemDto;
}

export interface InteractionResponseResultEvent {
  type: 'interaction_response_result';
  operationId: string;
  sessionId: string;
  interactionId: string;
  outcome: 'accepted' | 'skipped' | 'failed';
  message?: string;
}

export interface NotificationPreferencesUpdatedEvent {
  type: 'notification_preferences_updated';
  preferences: NotificationPreferencesDto;
}

export interface ThemeSettingsUpdatedEvent {
  type: 'theme_settings_updated';
  settings: AccountThemeSettingsDto;
}

export interface ConversationDefaultsUpdatedEvent {
  type: 'conversation_defaults_updated';
  user: PublicUserDto;
}

export interface ApprovalTrustUpdatedEvent {
  type: 'approval_trust_updated';
  scope: 'project' | 'session';
  scopeId: string;
}

export interface SidebarOrderUpdatedEvent {
  type: 'sidebar_order_updated';
  order: SidebarOrderDto;
}

export interface ErrorEvent {
  type: 'error';
  protocolVersion: 35;
  sessionId?: string;
  messageId?: string;
  message: string;
  code?: string;
  commandType?: 'subscribe' | 'unsubscribe' | 'send' | 'cancel' | 'cancel_followup' | 'resume_followups' | 'respond_interaction' | 'mark_session_read';
}

export interface SessionReadsEvent {
  type: 'session_reads';
  receipts: Record<string, string>;
}
export type FrontendEvent = ProtocolInfoEvent | RequestForwardedEvent | TurnStartEvent | TurnCompleteEvent | TurnCancellingEvent | TurnCancelledEvent | DeltaEvent | ItemStartEvent | ItemCompleteEvent | MessageCompleteEvent | MessageSavedEvent | EngineConcurrencyUpdatedEvent | TurnQueueUpdatedEvent | TurnQueueStartedEvent | SessionFollowupSnapshotEvent | SessionFollowupUpdatedEvent | SessionUpdatedEvent | EnginePreferencesUpdatedEvent | SessionDeletionProgressEvent | SessionDeletedEvent | ProjectUpdatedEvent | ProjectDeletedEvent | SyncStateEvent | RuntimeSyncStateEvent | ModelInfoEvent | TokenUsageEvent | PendingApprovalsSnapshotEvent | PendingApprovalUpsertedEvent | PendingApprovalResolvedEvent | InteractionResponseResultEvent | NotificationPreferencesUpdatedEvent | ThemeSettingsUpdatedEvent | ConversationDefaultsUpdatedEvent | ApprovalTrustUpdatedEvent | SidebarOrderUpdatedEvent | ErrorEvent | SessionReadsEvent;
