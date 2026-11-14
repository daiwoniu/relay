import {
  ChangedFileDtoSchema,
  ProcessTimelineEntrySchema,
  TokenUsageDtoSchema,
  MessageAttachmentDtoSchema,
  MessageModelInfoDtoSchema,
  ClientDiagnosticsDtoSchema,
  MessageOriginDtoSchema,
  type ChangedFileDto,
  type ProcessTimelineEntryDto,
  type TokenUsageDto,
  type MessageAttachmentDto,
  type MessageModelInfoDto,
  type ClientDiagnosticsDto,
  type MessageOriginDto,
} from './contracts/index.js';
import type { EngineTerminalOutcome } from './engine/turn-facts.js';

export interface MessageMetadata {
  replyToAsyncQuestionId?: string;
  processContent?: string;
  processTimeline?: ProcessTimelineEntryDto[];
  changedFiles?: ChangedFileDto[];
  changedFilesIncomplete?: boolean;
  executionStage?: 'accepted' | 'started' | 'responding';
  outcome?: 'completed' | 'failed' | 'stopped' | 'interrupted';
  errorCode?: string;
  errorMessage?: string;
  tokenUsage?: TokenUsageDto;
  attachments?: MessageAttachmentDto[];
  modelInfo?: MessageModelInfoDto;
  origin?: MessageOriginDto;
  clientDiagnostics?: ClientDiagnosticsDto;
}

export function serializeMessageMetadata(input?: string | null | MessageMetadata): string | null {
  const source: MessageMetadata = typeof input === 'string' || input == null
    ? { processContent: input || undefined }
    : input;
  const normalized: MessageMetadata = {
    ...(source.replyToAsyncQuestionId?.startsWith('async-question:') && source.replyToAsyncQuestionId.length <= 256
      ? { replyToAsyncQuestionId: source.replyToAsyncQuestionId }
      : {}),
    ...(source.processContent?.trim() ? { processContent: source.processContent.trim() } : {}),
    ...(source.processTimeline?.length
      ? { processTimeline: source.processTimeline.flatMap((entry) => {
        const parsed = ProcessTimelineEntrySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }) }
      : {}),
    ...(source.changedFiles?.length
      ? { changedFiles: source.changedFiles.flatMap((entry) => {
        const parsed = ChangedFileDtoSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }) }
      : {}),
    ...(source.changedFilesIncomplete === true ? { changedFilesIncomplete: true } : {}),
    ...(source.executionStage ? { executionStage: source.executionStage } : {}),
    ...(source.outcome ? { outcome: source.outcome } : {}),
    ...(source.errorCode?.trim() ? { errorCode: source.errorCode.trim() } : {}),
    ...(source.errorMessage?.trim() ? { errorMessage: source.errorMessage.trim() } : {}),
    ...(source.tokenUsage && TokenUsageDtoSchema.safeParse(source.tokenUsage).success ? { tokenUsage: source.tokenUsage } : {}),
    ...(source.attachments?.length
      ? { attachments: source.attachments.flatMap((entry) => {
        const parsed = MessageAttachmentDtoSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }) }
      : {}),
    ...(source.modelInfo && MessageModelInfoDtoSchema.safeParse(source.modelInfo).success
      ? { modelInfo: MessageModelInfoDtoSchema.parse(source.modelInfo) }
      : {}),
    ...(source.origin && MessageOriginDtoSchema.safeParse(source.origin).success
      ? { origin: MessageOriginDtoSchema.parse(source.origin) }
      : {}),
    ...(source.clientDiagnostics && ClientDiagnosticsDtoSchema.safeParse(source.clientDiagnostics).success
      ? { clientDiagnostics: ClientDiagnosticsDtoSchema.parse(source.clientDiagnostics) }
      : {}),
  };
  return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : null;
}

export function serializeTerminalMessageMetadata(
  outcome: EngineTerminalOutcome,
  input: Omit<MessageMetadata, 'outcome'> = {},
): string | null {
  return serializeMessageMetadata({
    ...input,
    outcome,
    ...(outcome === 'completed' ? { errorCode: undefined, errorMessage: undefined } : {}),
  });
}

export function parseMessageMetadata(metadata: string | null | undefined): MessageMetadata {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return {
      ...(typeof parsed.replyToAsyncQuestionId === 'string'
        && parsed.replyToAsyncQuestionId.startsWith('async-question:')
        && parsed.replyToAsyncQuestionId.length <= 256
        ? { replyToAsyncQuestionId: parsed.replyToAsyncQuestionId }
        : {}),
      ...(typeof parsed.processContent === 'string' && parsed.processContent.trim()
        ? { processContent: parsed.processContent }
        : {}),
      ...(Array.isArray(parsed.processTimeline)
        ? {
          processTimeline: parsed.processTimeline.flatMap((entry: unknown) => {
            const result = ProcessTimelineEntrySchema.safeParse(entry);
            return result.success ? [result.data] : [];
          }),
        }
        : {}),
      ...(Array.isArray(parsed.changedFiles)
        ? {
          changedFiles: parsed.changedFiles.flatMap((entry: unknown) => {
            const result = ChangedFileDtoSchema.safeParse(entry);
            return result.success ? [result.data] : [];
          }),
        }
        : {}),
      ...(parsed.changedFilesIncomplete === true ? { changedFilesIncomplete: true } : {}),
      ...(['accepted', 'started', 'responding'].includes(parsed.executionStage)
        ? { executionStage: parsed.executionStage as MessageMetadata['executionStage'] }
        : {}),
      ...(['completed', 'failed', 'stopped', 'interrupted'].includes(parsed.outcome)
        ? { outcome: parsed.outcome as MessageMetadata['outcome'] }
        : {}),
      ...(typeof parsed.errorCode === 'string' && parsed.errorCode.trim() ? { errorCode: parsed.errorCode } : {}),
      ...(typeof parsed.errorMessage === 'string' && parsed.errorMessage.trim() ? { errorMessage: parsed.errorMessage } : {}),
      ...(TokenUsageDtoSchema.safeParse(parsed.tokenUsage).success ? { tokenUsage: parsed.tokenUsage as TokenUsageDto } : {}),
      ...(Array.isArray(parsed.attachments)
        ? { attachments: parsed.attachments.flatMap((entry: unknown) => {
          const result = MessageAttachmentDtoSchema.safeParse(entry);
          return result.success ? [result.data] : [];
        }) }
        : {}),
      ...(MessageModelInfoDtoSchema.safeParse(parsed.modelInfo).success
        ? { modelInfo: MessageModelInfoDtoSchema.parse(parsed.modelInfo) }
        : {}),
      ...(MessageOriginDtoSchema.safeParse(parsed.origin).success
        ? { origin: MessageOriginDtoSchema.parse(parsed.origin) }
        : {}),
      ...(ClientDiagnosticsDtoSchema.safeParse(parsed.clientDiagnostics).success
        ? { clientDiagnostics: ClientDiagnosticsDtoSchema.parse(parsed.clientDiagnostics) }
        : {}),
    };
  } catch {
    return {};
  }
}
