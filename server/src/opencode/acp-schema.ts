import { z } from 'zod';

export const AcpInitializeResultSchema = z.object({
  protocolVersion: z.number(),
  agentCapabilities: z.record(z.unknown()).optional(),
}).passthrough();

export const AcpConfigOptionSchema = z.object({
  id: z.string(),
  category: z.string().optional(),
  currentValue: z.string().optional(),
  options: z.array(z.object({
    value: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export const AcpSessionResultSchema = z.object({
  sessionId: z.string().optional(),
  configOptions: z.array(AcpConfigOptionSchema).optional(),
}).passthrough();

export const AcpPromptResultSchema = z.object({
  stopReason: z.string().optional(),
  usage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

export const AcpSessionUpdateSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.string(),
  }).passthrough(),
  _meta: z.record(z.unknown()).optional(),
}).passthrough();