import { useEffect, useState } from 'react';
import { readFile, readImagePreviewSource } from '../../api/filesystem';
import type { AttachmentDraft } from './attachment-drafts';
import FileTypeIcon from '../messages/FileTypeIcon';

export default function AttachmentThumbnail({ attachment }: { attachment: AttachmentDraft }) {
  const [remotePreview, setRemotePreview] = useState<string>();
  const readyImagePath = attachment.kind === 'uploaded_file' && attachment.status === 'ready'
    && attachment.mimeType.startsWith('image/') && !attachment.previewUrl
    ? attachment.path
    : null;
  useEffect(() => {
    setRemotePreview(undefined);
    if (!readyImagePath) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    void readFile(readyImagePath).then(async (result) => {
      if (result.type === 'image' && result.dataUrl) return result.dataUrl;
      if (result.type === 'image-preview-required') {
        objectUrl = URL.createObjectURL(await readImagePreviewSource(readyImagePath));
        if (cancelled) { URL.revokeObjectURL(objectUrl); objectUrl = undefined; return undefined; }
        return objectUrl;
      }
      return undefined;
    }).then((preview) => { if (!cancelled && preview) setRemotePreview(preview); }).catch(() => undefined);
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [readyImagePath]);
  const image = attachment.kind === 'uploaded_file' && attachment.mimeType.startsWith('image/')
    ? attachment.previewUrl || remotePreview
    : undefined;
  return (
    <span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
      {image ? <img src={image} alt="" className="h-full w-full object-cover" /> : <FileTypeIcon filePath={attachment.name} size={17} />}
      {attachment.status === 'uploading' && (
        <span className="absolute inset-x-0 bottom-0 h-1 bg-black/20"><span className="block h-full bg-[var(--color-primary)]" style={{ width: `${attachment.progress}%` }} /></span>
      )}
    </span>
  );
}
