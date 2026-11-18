import Tooltip from '../ui/Tooltip';
import { useEffect, useState } from 'react';
import type { MessageAttachmentDto, MessageAttachmentSummaryDto } from '../../generated/relay-contracts';
import { readFile, readImagePreviewSource } from '../../api/filesystem';
import { useFilePreview } from './useFilePreview';
import FileTypeIcon from './FileTypeIcon';
import { getFileIconType } from './file-icon-type';

type DisplayAttachment = MessageAttachmentDto | MessageAttachmentSummaryDto;

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function MessageAttachmentThumbnail({ attachment, path }: { attachment: DisplayAttachment; path: string | null }) {
  const [imageUrl, setImageUrl] = useState<string>();
  const imagePath = path && (attachment.kind === 'uploaded_file' ? attachment.available && attachment.mimeType.startsWith('image/') : getFileIconType(attachment.name) === 'image') ? path : null;
  useEffect(() => {
    setImageUrl(undefined);
    if (!imagePath) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    void readFile(imagePath).then(async (result) => {
      if (result.type === 'image' && result.dataUrl) return result.dataUrl;
      if (result.type === 'image-preview-required') {
        objectUrl = URL.createObjectURL(await readImagePreviewSource(imagePath));
        if (cancelled) { URL.revokeObjectURL(objectUrl); objectUrl = undefined; return undefined; }
        return objectUrl;
      }
      return undefined;
    }).then((preview) => { if (!cancelled && preview) setImageUrl(preview); }).catch(() => undefined);
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [imagePath]);
  return <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)]">
    {imageUrl ? <img src={imageUrl} alt="" className="h-full w-full object-cover" /> : <FileTypeIcon filePath={attachment.name} size={15} />}
  </span>;
}

export default function MessageAttachmentList({ attachments, readOnly = false }: { attachments?: DisplayAttachment[]; readOnly?: boolean }) {
  const openFilePreview = useFilePreview();
  if (!attachments?.length) return null;
  return <div className="mb-2 grid gap-1.5" aria-label="消息附件">{attachments.map((attachment) => {
    const path = 'path' in attachment ? attachment.path : null;
    const available = attachment.kind === 'host_file' ? Boolean(path) : attachment.available;
  const label = attachment.kind === 'host_file' ? getFileIconType(attachment.name) === 'image' ? '主机图片' : '主机文件' : attachment.mimeType.startsWith('image/') ? '图片' : '设备文件';
    const content = <><MessageAttachmentThumbnail attachment={attachment} path={readOnly ? null : path} /><span className="min-w-0"><span data-attachment-name data-tooltip-full-text={path ?? attachment.name} className="block truncate text-xs font-medium">{attachment.name}</span><span className="block text-[11px] opacity-70">{label} · {formatFileSize(attachment.size)}{readOnly ? ' · 仅附件信息，不含文件内容' : !available ? attachment.kind === 'host_file' ? ' · 仅来源设备可访问' : ' · 文件已清理' : ''}</span></span></>;
    const className = "flex min-w-0 items-center gap-2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-left";
    return path && available && !readOnly
      ? <Tooltip overflowOnly overflowTarget="[data-attachment-name]" key={attachment.id} content={path} asChild><button type="button" onClick={() => void openFilePreview(path)} className={`${className} hover:bg-[var(--color-surface-hover)]`}>{content}</button></Tooltip>
      : <div key={attachment.id} className={className}>{content}</div>;
  })}</div>;
}
