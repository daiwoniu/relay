import { z } from 'zod';
import { createHash } from 'node:crypto';
import { normalize } from 'node:path';
import { ApprovalTrustDurationSchema, EngineIdSchema, FEISHU_MAX_CONCURRENCY } from '../../contracts/dto.js';

export const feishuIdentity = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const identity = feishuIdentity;
const optionalIdentity = identity.nullish().transform(value => value ?? null);
export const feishuTaskIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const feishuModelIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const feishuDefaultConcurrency = 2;
export const feishuConcurrencySchema = z.number().int().min(1).max(FEISHU_MAX_CONCURRENCY);
export const feishuApprovalChoice = z.union([z.literal('manual'), ApprovalTrustDurationSchema]);
export const feishuApprovalSetting = z.object({ choice: feishuApprovalChoice, expiresAt: z.number().int().nonnegative().safe().nullable() }).strict();
export const feishuEnginePreferences = z.object({
  engineId: EngineIdSchema, modelId: feishuModelIdSchema.nullable(),
  reasoningEffort: feishuModelIdSchema.nullable(), serviceTier: feishuModelIdSchema.nullable(),
}).strict();
export type FeishuEnginePreferences = z.output<typeof feishuEnginePreferences>;
export const feishuConversationOverride = z.object({
  kind: z.enum(['p2p', 'group']), targetId: identity, engine: z.enum(['bot', ...feishuEnginePreferences.shape.engineId.options]), model: feishuModelIdSchema.nullable(),
  reasoningEffort: feishuModelIdSchema.nullable().optional(), serviceTier: feishuModelIdSchema.nullable().optional(),
  approval: feishuApprovalSetting.optional(),
}).strict();
export const feishuContextTaskLimit = 2;
export const feishuContextTaskIdsSchema = z.array(feishuTaskIdSchema).max(feishuContextTaskLimit);

export const feishuInboundSchema = z.object({
  botId: identity,
  tenantKey: identity,
  eventId: optionalIdentity,
  messageId: identity,
  chatId: identity,
  chatType: z.enum(['group', 'p2p']).default('group'),
  carriedTaskIds: feishuContextTaskIdsSchema.optional(),
  senderId: identity,
  projectId: identity,
  policyKey: z.string().regex(/^[a-f0-9]{64}$/),
  threadId: optionalIdentity,
  rootId: optionalIdentity,
  parentId: optionalIdentity,
  createdAt: z.number().int().positive().safe().nullable(),
  text: z.string().min(1).max(8000),
  mentionOnly: z.literal(true).optional(),
}).strict();

export type FeishuInbound = z.output<typeof feishuInboundSchema>;

export function feishuOverrideFor(overrides: z.output<typeof feishuConversationOverride>[] | undefined,
  message: Pick<FeishuInbound, 'chatType' | 'chatId' | 'senderId'>) {
  const target = message.chatType === 'p2p' ? message.senderId : message.chatId;
  return overrides?.find(item => item.kind === message.chatType && item.targetId === target);
}

export function privateContextCommand(text: string) {
  const match = /^\/新建(?:[ \t\u3000]+(保留|清空))?$/.exec(text);
  if (!match) return null;
  return match[1] === '保留' ? 'carry' : match[1] === '清空' ? 'clear' : 'choose';
}

const feishuModelSettings = z.union([
  z.object({ model: feishuModelIdSchema, apiKey: z.string().min(1).max(512) }).strict(),
  z.object({ model: feishuModelIdSchema, engine: z.literal('codex') }).strict(),
]);

export const feishuBotConfigSchema = z.object({
  id: identity,
  appId: identity,
  appSecret: z.string().min(1).max(512),
  projectId: identity,
  summaryChatIds: z.array(identity).max(200).default([]),
  summary: feishuModelSettings.optional(),
  platformPreferences: feishuEnginePreferences.optional(),
  approval: feishuApprovalSetting.optional(),
  maxConcurrent: feishuConcurrencySchema.optional(),
  conversationOverrides: z.array(feishuConversationOverride).max(200).optional(),
}).strict();

export type FeishuBotSettings = z.output<typeof feishuBotConfigSchema>;
export type FeishuBotConfig = FeishuBotSettings & { workspaceName: string; workspacePath: string };

export function feishuBindingId(config: Pick<FeishuBotConfig, 'id' | 'appId' | 'projectId' | 'workspacePath'>) {
  const path = normalize(config.workspacePath);
  const workspacePath = process.platform === 'win32' ? path.toLowerCase() : path;
  return createHash('sha256').update(JSON.stringify([
    config.id, config.appId, config.projectId, workspacePath,
  ])).digest('hex');
}

export function feishuPolicyKey(config: FeishuBotConfig, chatId: string) {
  return createHash('sha256').update(JSON.stringify([feishuBindingId(config),
    config.summaryChatIds.includes(chatId), config.summary?.model ?? null,
    ...(config.summary && 'engine' in config.summary ? [config.summary.engine] : [])])).digest('hex');
}

const eventSchema = z.object({
  app_id: identity,
  tenant_key: identity,
  event_id: optionalIdentity,
  sender: z.object({ sender_type: z.literal('user'), sender_id: z.object({ open_id: identity }) }),
  message: z.object({
    chat_type: z.enum(['group', 'p2p']),
    chat_id: identity,
    message_id: identity,
    thread_id: optionalIdentity,
    root_id: optionalIdentity,
    parent_id: optionalIdentity,
    create_time: z.string().regex(/^\d{10,15}$/).optional(),
    message_type: z.literal('text'),
    content: z.string().max(32000),
    mentions: z.array(z.object({ key: z.string().regex(/^@_user_\d+$/), id: z.object({ open_id: identity.optional() }) })).max(100).default([]),
  }),
});

const contentSchema = z.object({ text: z.string().max(8000) });

export function normalizeFeishuInbound(config: FeishuBotConfig, botOpenId: string, input: unknown): FeishuInbound | null {
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) return null;
  const { app_id, tenant_key, event_id, sender, message } = parsed.data;
  if (app_id !== config.appId) return null;
  const senderId = sender.sender_id.open_id;
  const mention = message.mentions.find(item => item.id.open_id === botOpenId);
  if (senderId === botOpenId || (message.chat_type === 'group' && !mention)) return null;

  let content: unknown;
  try { content = JSON.parse(message.content); } catch { return null; }
  const value = contentSchema.safeParse(content);
  if (!value.success) return null;
  const text = value.data.text.replace(/@_user_\d+/g, key => key === mention?.key ? '' : key).trim();
  const mentionOnly = !text && message.chat_type === 'group' && value.data.text.trim() === mention?.key;
  if (!text && !mentionOnly) return null;
  return feishuInboundSchema.parse({ botId: feishuBindingId(config), tenantKey: tenant_key, eventId: event_id,
    messageId: message.message_id, chatId: message.chat_id, chatType: message.chat_type, senderId,
    projectId: config.projectId, policyKey: feishuPolicyKey(config, message.chat_id),
    threadId: message.chat_type === 'group' ? message.thread_id : null, rootId: message.root_id, parentId: message.parent_id,
    createdAt: message.create_time ? Number(message.create_time) : null,
    text: mentionOnly ? '@机器人' : text, ...(mentionOnly ? { mentionOnly: true } : {}) });
}
