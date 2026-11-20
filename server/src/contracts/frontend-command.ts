import { z } from 'zod';
import { ClientDiagnosticsDtoSchema, ClientEnvironmentDtoSchema, EngineIdSchema, EnginePreferencesDtoSchema, SendAttachmentDtoSchema } from './dto.js';

export const SubscribeCommandSchema = z.object({
  type: z.literal('subscribe'),
  sessionId: z.string().uuid(),
  active: z.boolean().optional(),
  includeMessages: z.boolean().optional(),
  deviceId: z.string().min(1).max(128).optional(),
  resourceScope: z.enum(['mine', 'all']).optional(),
  client: ClientEnvironmentDtoSchema.optional(),
}).strict();

export const UnsubscribeCommandSchema = z.object({
  type: z.literal('unsubscribe'),
  sessionId: z.string().uuid(),
}).strict();

export const SendCommandSchema = z.object({
  type: z.literal('send'),
  sessionId: z.string().uuid(),
  content: z.string().max(100_000),
  engine: EngineIdSchema.optional(),
  enginePreferences: EnginePreferencesDtoSchema.optional(),
  messageId: z.string().min(1).max(128).optional(),
  workspaceTaskId: z.string().min(1).max(256).optional(),
  workspaceId: z.string().min(1).max(128).optional(),
  replyToAsyncQuestionId: z.string().startsWith('async-question:').max(256).optional(),
  attachments: z.array(SendAttachmentDtoSchema).max(10).optional(),
  client: ClientEnvironmentDtoSchema.optional(),
  clientDiagnostics: ClientDiagnosticsDtoSchema.optional(),
}).strict();

export const CancelCommandSchema = z.object({
  type: z.literal('cancel'),
  sessionId: z.string().uuid().optional(),
}).strict();

export const CancelFollowupCommandSchema = z.object({
  type: z.literal('cancel_followup'),
  sessionId: z.string().uuid(),
  messageId: z.string().min(1).max(128),
}).strict();

export const ResumeFollowupsCommandSchema = z.object({
  type: z.literal('resume_followups'),
  sessionId: z.string().uuid(),
}).strict();

export const RespondInteractionCommandSchema = z.object({
  type: z.literal('respond_interaction'),
  operationId: z.string().uuid(),
  sessionId: z.string().uuid(),
  interactionId: z.string().min(1).max(256),
  action: z.enum(['accept', 'accept_for_session', 'decline', 'cancel', 'submit']),
  answers: z.record(z.array(z.string().max(20_000))).optional(),
  formData: z.record(z.unknown()).optional(),
}).strict();

export const MarkSessionReadCommandSchema = z.object({ type: z.literal('mark_session_read'), sessionId: z.string().uuid(), messageId: z.string().min(1).max(128) }).strict();

export const FrontendCommandSchema = z.discriminatedUnion('type', [
  MarkSessionReadCommandSchema,
  SubscribeCommandSchema,
  UnsubscribeCommandSchema,
  SendCommandSchema,
  CancelCommandSchema,
  CancelFollowupCommandSchema,
  ResumeFollowupsCommandSchema,
  RespondInteractionCommandSchema,
]);

export type SubscribeCommand = z.infer<typeof SubscribeCommandSchema>;
export type UnsubscribeCommand = z.infer<typeof UnsubscribeCommandSchema>;
export type SendCommand = z.infer<typeof SendCommandSchema>;
export type CancelCommand = z.infer<typeof CancelCommandSchema>;
export type CancelFollowupCommand = z.infer<typeof CancelFollowupCommandSchema>;
export type ResumeFollowupsCommand = z.infer<typeof ResumeFollowupsCommandSchema>;
export type RespondInteractionCommand = z.infer<typeof RespondInteractionCommandSchema>;
export type FrontendCommand = z.infer<typeof FrontendCommandSchema>;
