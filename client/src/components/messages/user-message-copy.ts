import type { MessageAttachmentDto, MessageAttachmentSummaryDto } from '../../generated/relay-contracts.ts';

export function createUserMessageCopyText(
  content: string,
  attachments?: MessageAttachmentDto[] | MessageAttachmentSummaryDto[],
): string {
  const attachmentText = (attachments || [])
    .map((attachment) => `附件：${attachment.name}`)
    .join('\n');
  if (!attachmentText) return content;
  return content ? `${content}\n\n${attachmentText}` : attachmentText;
}
