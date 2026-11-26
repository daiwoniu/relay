import { z } from 'zod';
import { createHash } from 'node:crypto';
import { normalize } from 'node:path';
import { ApprovalTrustDurationSchema, EngineIdSchema, FEISHU_MAX_CONCURRENCY } from '../../contracts/dto.js';

export const feishuIdentity = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const feishuConversationFilters = {
  q: z.string().trim().min(1).max(120).optional(),
  chatType: z.enum(['p2p', 'group']).optional(),
  attention: z.enum(['approval', 'failed', 'unknown', 'reply_failed', 'reply_unknown', 'reply_anomaly']).optional(),
};
export const feishuStatsBuckets = z.enum(['hour', 'day', 'week']);
export const feishuStatsDimensions = z.enum(['robot', 'group', 'p2p', 'model']);
export const feishuStatsMetrics = z.enum(['received', 'anomalies', 'tokens']);
const identity = feishuIdentity;
const optionalIdentity = identity.nullish().transform(value => value ?? null);
export const feishuTaskIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const feishuModelIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const feishuDefaultConcurrency = 2;
export const feishuConcurrencySchema = z.number().int().min(1).max(FEISHU_MAX_CONCURRENCY);
export const feishuApprovalChoice = z.union([z.literal('manual'), ApprovalTrustDurationSchema]);
export const feishuManualDecisions = ['accept', 'decline', 'cancel'] as const;
export type FeishuManualDecision = typeof feishuManualDecisions[number];
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
export const feishuAttachmentSchema = z.object({
  type: z.enum(['image', 'file']), key: feishuIdentity, name: z.string().max(255).optional(),
}).strict();
export type FeishuAttachment = z.output<typeof feishuAttachmentSchema>;

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
  attachments: z.array(feishuAttachmentSchema).min(1).max(10).optional(),
  contentIssue: z.enum(['unsupported', 'too_many_attachments']).optional(),
  messageType: z.string().min(1).max(80).optional(),
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
    message_type: z.string().min(1).max(80),
    content: z.unknown(),
    mentions: z.array(z.object({ key: z.string().regex(/^@_user_\d+$/), id: z.object({ open_id: identity.optional() }) })).max(100).default([]),
  }),
});

const contentSchema = z.object({ text: z.string().max(8000) });
const richPost = z.object({
  title: z.string().optional(),
  content: z.array(z.array(z.object({
    tag: z.string(), text: z.string().optional(), href: z.string().optional(), image_key: identity.optional(),
    file_key: identity.optional(), file_name: z.string().max(255).optional(),
  }))),
});

function readMessageContent(type: string, raw: unknown): { text: string; attachments: FeishuAttachment[] } | null {
  if (typeof raw !== 'string' || !raw || raw.length > 32000) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (type === 'text') {
    const text = contentSchema.safeParse(value);
    return text.success ? { text: text.data.text, attachments: [] } : null;
  }
  if (type === 'image' || type === 'file') {
    const resource = z.object({ image_key: identity.optional(), file_key: identity.optional(),
      file_name: z.string().max(255).optional() }).safeParse(value);
    if (!resource.success) return null;
    const key = type === 'image' ? resource.data.image_key : resource.data.file_key;
    if (!key) return null;
    return { text: '', attachments: [{ type, key, ...(resource.data.file_name ? { name: resource.data.file_name } : {}) }] };
  }
  if (type !== 'post' || !value || typeof value !== 'object') return null;
  const post = [value, ...Object.values(value)].map(item => richPost.safeParse(item)).find(item => item.success);
  if (!post?.success) return null;
  const resources = new Map<string, FeishuAttachment>();
  for (const node of post.data.content.flat()) {
    switch (node.tag) {
      case 'img':
        if (!node.image_key) return null;
        resources.set('image:' + node.image_key, { type: 'image', key: node.image_key });
        break;
      case 'file':
        if (!node.file_key) return null;
        resources.set('file:' + node.file_key, { type: 'file', key: node.file_key, ...(node.file_name ? { name: node.file_name } : {}) });
        break;
      case 'text': case 'a': case 'at': case 'md': case 'code_block': case 'hr': case 'emotion':
        break;
      default:
        return null;
    }
  }
  const text = [post.data.title, ...post.data.content.map(line => line.map(node => {
    if (node.tag === 'a' && node.href) return node.text ? `${node.text} (${node.href})` : node.href;
    return node.text ?? '';
  }).join(''))].filter(Boolean).join('\n');
  return { text, attachments: [...resources.values()] };
}

export function normalizeFeishuInbound(config: FeishuBotConfig, botOpenId: string, input: unknown): FeishuInbound | null {
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) return null;
  const { app_id, tenant_key, event_id, sender, message } = parsed.data;
  if (app_id !== config.appId) return null;
  const senderId = sender.sender_id.open_id;
  const mention = message.mentions.find(item => item.id.open_id === botOpenId);
  if (senderId === botOpenId || (message.chat_type === 'group' && !mention)) return null;

  const direct = message.chat_type === 'p2p';
  const content = direct || message.message_type === 'text' ? readMessageContent(message.message_type, message.content) : null;
  const text = (content?.text ?? '').replace(/@_user_\d+/g, key => key === mention?.key ? '' : key).trim();
  const mentionOnly = !text && !direct && content?.text.trim() === mention?.key && !!content;
  const attachments = content?.attachments ?? [];
  const contentIssue = attachments.length > 10 ? 'too_many_attachments'
    : text.length > 8000 || (!text && !attachments.length && !mentionOnly) ? 'unsupported' : undefined;
  const storedText = text.slice(0, 8000) || (mentionOnly ? '@机器人' : attachments.length ? '请查看附件。' : '（暂不支持的消息）');
  return feishuInboundSchema.parse({ botId: feishuBindingId(config), tenantKey: tenant_key, eventId: event_id,
    messageId: message.message_id, chatId: message.chat_id, chatType: message.chat_type, senderId,
    projectId: config.projectId, policyKey: feishuPolicyKey(config, message.chat_id),
    threadId: message.chat_type === 'group' ? message.thread_id : null, rootId: message.root_id, parentId: message.parent_id,
    createdAt: message.create_time ? Number(message.create_time) : null,
    text: storedText, ...(mentionOnly ? { mentionOnly: true } : {}),
    ...(contentIssue ? { contentIssue, messageType: message.message_type } : attachments.length ? { attachments } : {}) });
}
