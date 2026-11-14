import fs from 'node:fs';
import path from 'node:path';
import { fileAccessGrants } from '../file-access.js';
import type {
  AuthorizedHostFileAttachmentDto,
  HostFileAttachmentDto,
} from '../contracts/index.js';

function attachmentPathKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

export function validateHostFileAttachments(
  input: AuthorizedHostFileAttachmentDto[] | undefined,
  ownerUserId?: string,
): HostFileAttachmentDto[] {
  if (!input?.length) return [];
  try {
    const seen = new Set<string>();
    return input.map((attachment) => {
      if (!path.isAbsolute(attachment.path)) throw new Error('附件路径必须是绝对路径');
      let realPath: string;
      try {
        realPath = fs.realpathSync(attachment.path);
      } catch {
        throw new Error(`附件不存在或不可访问：${attachment.name}`);
      }
      const stat = fs.statSync(realPath);
      if (!stat.isFile()) throw new Error(`附件不是普通文件：${attachment.name}`);
      if (!fileAccessGrants.allows(realPath, attachment.accessToken, ownerUserId)) {
        throw new Error(`附件授权已失效，请重新选择：${attachment.name}`);
      }
      const key = attachmentPathKey(realPath);
      if (seen.has(key)) throw new Error(`不能重复添加同一个附件：${path.basename(realPath)}`);
      seen.add(key);
      return {
        id: attachment.id,
        kind: 'host_file' as const,
        name: path.basename(realPath),
        path: realPath,
        size: stat.size,
      };
    });
  } finally {
    for (const attachment of input) fileAccessGrants.revoke(attachment.accessToken, ownerUserId);
  }
}

export function composeCodexInput(content: string, attachments: HostFileAttachmentDto[]): string {
  const trimmed = content.trim();
  if (attachments.length === 0) return trimmed;
  const heading = trimmed
    ? '附件文件（Relay 主机绝对路径）：'
    : '请查看以下附件文件（Relay 主机绝对路径）：';
  const attachmentList = attachments.map((attachment) => `- ${attachment.path}`).join('\n');
  return trimmed ? `${trimmed}\n\n${heading}\n${attachmentList}` : `${heading}\n${attachmentList}`;
}
