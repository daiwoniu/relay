import type { SessionStatus } from '../contracts/index.js';
import type { EngineTerminalDecision } from '../engine/turn-facts.js';
import type { UserRole } from './user-role.js';

export type { SessionStatus } from '../contracts/index.js';

export type EngineId = 'codex' | 'codebuddy' | 'opencode' | 'zcode';

export interface Project {
  id: string;
  name: string;
  path: string;
  normalized_path?: string | null;
  owner_user_id?: string | null;
  created_at: number;
  updated_at: number;
  pinned: number;
  pinned_at?: number | null;
  is_system: number;
  deleted_at?: number | null;
  deletion_protected?: number;
  access_role?: 'owner' | 'viewer' | 'collaborator' | 'manager';
  members_can_view_sessions?: number;
  session_count?: number;
}
export interface Session {
  id: string;
  title: string;
  title_manually_set: number;
  created_at: number;
  updated_at: number;
  pinned: number;
  pinned_at?: number | null;
  archived: number;
  project_id: string | null;
  owner_user_id?: string | null;
  engine: EngineId | null;
  engine_bound?: number;
  engine_session_id: string | null;
  engine_metadata: string | null;
  codex_thread_id: string | null;
  codex_archived: number;
  codex_archived_for_trash?: number;
  status: SessionStatus;
  last_result?: import('../contracts/dto.js').SessionDto['last_result'];
  token_usage: string | null;
  active_turn_usage: string | null;
  active_turn_id?: string | null;
  active_attempt_id?: string | null;
  active_turn_started_at?: number | null;
  recovery_previous_status?: string | null;
  message_revision?: number;
  message_count?: number;
  assistant_message_count?: number;
  context_compaction_count?: number;
  selected_model_id?: string | null;
  selected_reasoning_effort?: string | null;
  selected_service_tier?: string | null;
  engine_preferences_revision?: number;
  deleted_at?: number | null;
}

export interface Message {
  id: string;
  session_id: string;
  turn_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  phase: string | null;
  items: string | null;
  metadata: string | null;
  created_at: number;
  duration: number | null;
  stopped: number;
}

export interface MessageCursor {
  beforeCreatedAt: number;
  beforeId: string;
}

export interface MessagePageRecord {
  messages: Message[];
  revision: number;
  hasMore: boolean;
  nextCursor: MessageCursor | null;
}

export interface SavedMessageRecord {
  message: Message;
  revision: number;
}

export interface EngineTerminalProjectionRecord {
  decision: EngineTerminalDecision;
  message: NewMessageRecord;
  sessionStatus: Extract<SessionStatus, 'idle' | 'completed' | 'failed' | 'interrupted' | 'stopped'>;
}

export interface EngineTerminalProjectionResult {
  projected: boolean;
  decision: EngineTerminalDecision;
  savedMessage: SavedMessageRecord;
  releasedResourceKey?: string | null;
}

export type NewMessageRecord = Omit<Message, 'created_at' | 'duration' | 'stopped'> & {
  duration?: number | null;
  stopped?: number;
};

export interface MessageSearchSnippet {
  text: string;
  matchStart: number;
  matchLength: number;
}

export interface SessionMessageSearchMatchRecord {
  messageId: string;
  role: 'user' | 'assistant';
  createdAt: number;
  scope: 'message' | 'process' | 'operation';
  itemId?: string;
  snippet: MessageSearchSnippet;
}

export interface SessionMessageSearchOptions {
  includeProcess?: boolean;
  includeOperations?: boolean;
}

export interface SessionSearchRecord {
  session: Session;
  titleMatched: boolean;
  messageMatchCount: number;
  latestMessageMatch: SessionMessageSearchMatchRecord | null;
}

export interface SessionMessageSearchPageRecord {
  total: number;
  truncated: boolean;
  matches: SessionMessageSearchMatchRecord[];
}

export interface SharedRecord {
  id: string;
  public_token: string;
  owner_user_id: string;
  source_session_id: string | null;
  title: string;
  scope: 'single' | 'selection' | 'session';
  message_count: number;
  include_process: number;
  snapshot_version: number;
  snapshot_json: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface SharedRecordWithSourceTitle extends SharedRecord {
  source_session_title: string | null;
  source_session_engine: EngineId | null;
}

export interface User {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  display_name?: string | null;
  avatar_mime?: string | null;
  avatar_data?: Uint8Array | null;
  avatar_updated_at?: number | null;
  default_project_id?: string | null;
  default_engine?: EngineId;
  default_model_id?: string | null;
  must_change_password?: number;
  disabled_at?: number | null;
  can_create_project?: number;
  created_at: number;
  updated_at: number;
}

export interface AuthSession {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export interface NotificationPreferences {
  desktopSystemEnabled: boolean;
  desktopSoundEnabled: boolean;
  desktopSessionEndSystemEnabled: boolean;
  desktopSessionEndSoundEnabled: boolean;
  mobileSystemEnabled: boolean;
  mobileSoundEnabled: boolean;
  mobileSessionEndSystemEnabled: boolean;
  mobileSessionEndSoundEnabled: boolean;
  approvalSound: NotificationSound;
  sessionEndSound: NotificationSound;
  desktopSoundVolume: number;
  mobileSoundVolume: number;
}

export type NotificationSound = 'gentle_dual' | 'crisp' | 'soft_chime' | 'short_tone' | 'high_dual' | 'rising_triple' | 'falling_low';

export type NotificationPreferencesUpdate = Partial<NotificationPreferences>;

export interface ThemeAssetRecord {
  id: string;
  user_id: string;
  created_at: number;
}
