import { downloadFile } from '../../api/filesystem';
import type { RightPanelTab } from '../../stores/chat';

/** Save only a successfully received file, never an API error or a failed preview's text. */
export async function downloadPreviewFile(
  tab: RightPanelTab,
  signal?: AbortSignal,
  canSave: () => boolean = () => true,
): Promise<void> {
  const sourcePath = tab.sourcePath || tab.title;
  const serverFile = /^[A-Za-z]:[\\/]/.test(sourcePath) || sourcePath.startsWith('\\\\') || sourcePath.startsWith('/') || sourcePath.startsWith('~/');
  let blob: Blob | undefined;
  let directUrl: string | undefined;
  if (serverFile) {
    // Downloads remain available when the file exists but its preview format is unsupported.
    blob = await downloadFile(sourcePath, tab.fileAccessToken, { signal });
  } else if (tab.loading || tab.previewError || tab.forceAccessAvailable) {
    throw new Error(tab.previewError || '文件尚不可用，请先读取文件或确认访问权限。');
  } else if (tab.isImage && tab.imageUrl) {
    directUrl = tab.imageUrl;
  } else {
    blob = new Blob([tab.content], { type: 'text/plain;charset=utf-8' });
  }
  signal?.throwIfAborted();
  if (!canSave()) return;
  const objectUrl = blob ? URL.createObjectURL(blob) : undefined;
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl || directUrl!;
    anchor.download = tab.title.split(/[\\/]/).pop() || tab.title;
    try {
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    // Allow the browser to consume the Blob before releasing its temporary URL.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
