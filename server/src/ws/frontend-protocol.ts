import {
  FrontendCommandSchema,
  type UsageDto,
} from '../contracts/index.js';
import type { RuntimeTurnItem, SessionRuntime } from '../engine/runtime.js';

export const VISIBLE_ITEM_TYPES = new Set([
  'commandExecution', 'webSearch', 'fileChange', 'reasoning',
  'mcpToolCall', 'dynamicToolCall', 'plan', 'collabAgentToolCall',
  'subAgentActivity', 'imageGeneration',
  'interaction', 'systemNotice', 'contextCompaction',
]);

export function parseFrontendMessage(input: unknown) {
  return FrontendCommandSchema.parse(input);
}

export function upsertTurnItem(items: RuntimeTurnItem[], incoming: RuntimeTurnItem): RuntimeTurnItem[] {
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index < 0) return [...items, incoming];
  const current = items[index];
  const currentDetails = current.details && typeof current.details === 'object' ? current.details as Record<string, unknown> : {};
  const incomingDetails = incoming.details && typeof incoming.details === 'object' ? incoming.details as Record<string, unknown> : {};
  const mergedDetails = { ...currentDetails, ...Object.fromEntries(Object.entries(incomingDetails).filter(([, value]) => value !== undefined)) };
  if (typeof currentDetails.output === 'string' && typeof incomingDetails.output === 'string' && incomingDetails.output !== currentDetails.output) {
    mergedDetails.output = `${currentDetails.output}${incomingDetails.output}`;
  }
  const merged = (Object.keys(currentDetails).length || Object.keys(incomingDetails).length)
    ? { ...current, ...incoming, details: mergedDetails }
    : { ...current, ...incoming };
  const next = items.filter((item) => item.id !== incoming.id);
  next.splice(index, 0, merged);
  return next;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function getEngineDisplayName(engine: SessionRuntime['engine']): 'Codex' | 'CodeBuddy' | 'OpenCode' | 'ZCode' {
  return engine === 'codebuddy' ? 'CodeBuddy' : engine === 'opencode' ? 'OpenCode' : engine === 'zcode' ? 'ZCode' : 'Codex';
}

export function getEngineErrorPrefix(engine: SessionRuntime['engine']): 'CODEX' | 'CODEBUDDY' | 'OPENCODE' | 'ZCODE' {
  return engine === 'codebuddy' ? 'CODEBUDDY' : engine === 'opencode' ? 'OPENCODE' : engine === 'zcode' ? 'ZCODE' : 'CODEX';
}

export function presentUsage(usage: unknown): UsageDto | null {
  if (!usage || typeof usage !== 'object') return null;
  const value = usage as Record<string, unknown>;
  return {
    ...(typeof value.promptTokens === 'number' ? { promptTokens: value.promptTokens } : {}),
    ...(typeof value.completionTokens === 'number' ? { completionTokens: value.completionTokens } : {}),
    ...(typeof value.totalTokens === 'number' ? { totalTokens: value.totalTokens } : {}),
  };
}

export function getRuntimeExecutionStage(runtime: SessionRuntime): 'accepted' | 'started' | 'responding' {
  if (runtime.currentContent || runtime.commentaryContent || runtime.finalAnswerContent || runtime.turnItems.length > 0) {
    return 'responding';
  }
  return runtime.currentTurnId ? 'started' : 'accepted';
}
