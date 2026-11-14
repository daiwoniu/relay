import type { MessageAttachmentDto, SendAttachmentDto } from '../../generated/relay-contracts';
import type { Message } from '../../stores/chat';

export function buildOptimisticUserMessage(input: {
  sessionId: string; messageId: string; content: string;
  attachments: SendAttachmentDto[]; replyToAsyncQuestionId?: string;
}): Message {
  const attachments: MessageAttachmentDto[] = input.attachments.map((attachment) => {
    if (attachment.kind === 'host_file') {
      const { accessToken: _accessToken, ...presented } = attachment;
      return presented;
    }
    const { messageId: _messageId, uploadId: _uploadId, projectId: _projectId, ...presented } = attachment;
    return { ...presented, available: true };
  });
  return {
    id: input.messageId, session_id: input.sessionId, turn_id: '', role: 'user',
    content: input.content, phase: null, created_at: Date.now(), duration: null, stopped: false,
    ...(input.replyToAsyncQuestionId ? { replyToAsyncQuestionId: input.replyToAsyncQuestionId } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}
