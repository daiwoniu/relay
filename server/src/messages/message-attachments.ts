import type {
  AuthorizedHostFileAttachmentDto,
  MessageAttachmentDto,
  SendAttachmentDto,
  UploadedFileDraftDto,
} from '../contracts/index.js';
import { projectUploadStore, type ProjectUploadStore, UploadError } from '../uploads/project-uploads.js';
import { validateHostFileAttachments } from './host-file-attachments.js';

export function composeMessageCodexInput(content: string, attachments: MessageAttachmentDto[]): string {
  const trimmed = content.trim();
  if (attachments.length === 0) return trimmed;
  const heading = trimmed
    ? '附件文件（Relay 主机绝对路径）：'
    : '请查看以下附件文件（Relay 主机绝对路径）：';
  const attachmentList = attachments.map((attachment) => `- ${attachment.path}`).join('\n');
  return trimmed ? `${trimmed}\n\n${heading}\n${attachmentList}` : `${heading}\n${attachmentList}`;
}

export function prepareMessageAttachments(input: {
  attachments: SendAttachmentDto[] | undefined;
  projectId: string;
  projectPath: string;
  userId: string;
  messageId: string;
  uploadStore?: Pick<ProjectUploadStore, 'prepareArchive'>;
}): { attachments: MessageAttachmentDto[]; codexInput: (content: string) => string; rollback: () => void } {
  const hostDrafts = (input.attachments || []).filter(
    (attachment): attachment is AuthorizedHostFileAttachmentDto => attachment.kind === 'host_file',
  );
  const uploadedDrafts = (input.attachments || []).filter(
    (attachment): attachment is UploadedFileDraftDto => attachment.kind === 'uploaded_file',
  );
  const archived = (input.uploadStore || projectUploadStore).prepareArchive({
    projectPath: input.projectPath,
    projectId: input.projectId,
    userId: input.userId,
    messageId: input.messageId,
    drafts: uploadedDrafts,
  });
  try {
    const hostAttachments = validateHostFileAttachments(hostDrafts, input.userId);
    let hostIndex = 0;
    let uploadedIndex = 0;
    const attachments: MessageAttachmentDto[] = (input.attachments || []).map((attachment) => (
      attachment.kind === 'host_file'
        ? hostAttachments[hostIndex++]
        : archived.attachments[uploadedIndex++]
    ));
    return {
      attachments,
      codexInput: (content) => composeMessageCodexInput(content, attachments),
      rollback: archived.rollback,
    };
  } catch (error) {
    try { archived.rollback(); } catch {
      throw new UploadError(500, '附件验证失败且已归档文件未能完整回滚', 'UPLOAD_ROLLBACK_FAILED');
    }
    throw error;
  }
}
