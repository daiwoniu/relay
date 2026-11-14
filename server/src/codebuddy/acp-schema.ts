import { z } from 'zod';

export const AcpInitializeResultSchema = z.object({
  protocolVersion: z.number(),
  agentCapabilities: z.record(z.unknown()).optional(),
}).passthrough();

export const AcpSessionResultSchema = z.object({
  sessionId: z.string().optional(),
  models: z.object({
    currentModelId: z.string().optional(),
    availableModels: z.array(z.object({
      modelId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      _meta: z.object({
        maxInputTokens: z.number().optional(),
        supportsImages: z.boolean().optional(),
        supportsReasoning: z.boolean().optional(),
        credits: z.string().optional(),
      }).passthrough().optional(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
  configOptions: z.array(z.object({
    id: z.string(),
    category: z.string().optional(),
    // CodeBuddy 2.148 起新增 `type: boolean` 的多任务开关，取值是布尔而不是字符串。
    currentValue: z.union([z.string(), z.boolean()]).optional(),
    options: z.array(z.object({
      value: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

export const AcpPromptResultSchema = z.object({
  stopReason: z.string().optional(),
  _meta: z.object({
    'codebuddy.ai/outcome': z.string().optional(),
    'codebuddy.ai/finishReason': z.string().optional(),
    'codebuddy.ai/businessFailed': z.boolean().optional(),
    'codebuddy.ai/cancelReason': z.string().optional(),
    'codebuddy.ai/errorMessage': z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export const AcpSessionUpdateSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.string(),
  }).passthrough(),
  _meta: z.record(z.unknown()).optional(),
}).passthrough();

export function isHistoryUpdate(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const meta = (value as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== 'object') return false;
  const marker = (meta as Record<string, unknown>)['codebuddy.ai'];
  return Boolean(marker && typeof marker === 'object' && (marker as Record<string, unknown>).mode === 'history');
}
