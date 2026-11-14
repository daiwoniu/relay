import type { ProcessTimelineEntry } from '../process-timeline.js';
// Codex WebSocket protocol types based on generated JSON Schema
// These are the core types needed for message streaming

export interface AgentMessageDeltaNotification {
  type: 'agent_message_delta';
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
  phase?: 'commentary' | 'final_answer';
}

export interface ItemStartedNotification {
  type: 'item_started';
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface ItemCompletedNotification {
  type: 'item_completed';
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface TurnStartedNotification {
  type: 'turn_started';
  threadId: string;
  turnId: string;
}

export interface TurnCompletedNotification {
  type: 'turn_completed';
  threadId: string;
  turnId: string;
}

export type CodexServerRequestId = string | number;

export interface CodexServerRequest {
  type: 'server_request';
  requestId: CodexServerRequestId;
  method: string;
  params: Record<string, any>;
}

export interface CodexServerRequestResolved {
  type: 'server_request_resolved';
  requestId: CodexServerRequestId;
}

export interface CodexSystemNotice {
  type: 'system_notice';
  noticeType: 'warning' | 'guardian_warning' | 'config_warning' | 'deprecation' | 'model_rerouted' | 'context_compaction';
  title: string;
  message?: string;
  details?: Record<string, any>;
  contextCompaction?: { threadId: string; turnId: string };
}

export type ThreadItemType =
  | 'userMessage'
  | 'agentMessage'
  | 'reasoning'
  | 'commandExecution'
  | 'fileChange'
  | 'collabAgentToolCall'
  | 'subAgentActivity'
  | 'webSearch'
  | 'imageGeneration'
  | 'imageView'
  | 'plan'
  | 'mcpToolCall'
  | 'dynamicToolCall'
  | 'hookPrompt'
  | 'sleep'
  | 'contextCompaction'
  | 'enteredReviewMode'
  | 'exitedReviewMode';

export interface ThreadItem {
  id: string;
  type: ThreadItemType;
  status: 'in_progress' | 'completed' | 'incomplete';
  role?: string;
  content?: string;
  name?: string;
  [key: string]: any;
}

// Union type for all Codex notifications
export type CodexNotification =
  | AgentMessageDeltaNotification
  | ItemStartedNotification
  | ItemCompletedNotification
  | TurnStartedNotification
  | TurnCompletedNotification
  | { type: string; [key: string]: any };

// Frontend-facing message types (simplified for UI)
export type RelayWSMessage =
  | { type: 'capacity_observation'; observation: { type: 'request_retry' | 'completion_retry' } }
  | { type: 'request_forwarded' }
  | { type: 'delta'; itemId: string; content: string; phase?: string }
  | { type: 'item_start'; item: ThreadItem }
  | { type: 'item_complete'; item: ThreadItem; threadId?: string; turnId?: string }
  | { type: 'turn_start'; turnId: string }
  | { type: 'turn_complete'; turnId: string }
  | { type: 'message_complete'; turnId: string; content: string; processContent?: string; finalAnswerItemId?: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null }
  | { type: 'error'; message: string; code?: string; retryAfterMs?: number }
  | { type: 'sync'; sessions: any[]; messages: any[] }
  | { type: 'model_info'; model: string; platformOs?: string; modelProvider?: string; reasoningEffort?: string }
  | { type: 'token_usage'; usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number; modelContextWindow: number | null } }
  | {
    type: 'recovery_snapshot';
    turnId: string;
    status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
    content: string;
    processContent?: string;
    finalAnswerItemId?: string;
    processTimeline?: ProcessTimelineEntry[];
    items: ThreadItem[];
    waitingOnInteraction: boolean;
    durationMs?: number | null;
    error?: { message: string; code: string } | null;
  }
  | CodexServerRequest
  | CodexServerRequestResolved
  | CodexSystemNotice;
