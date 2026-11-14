import JSZip from 'jszip';
import {
  MAX_ZIP_COMPRESSION_RATIO,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_SIZE,
  MAX_ZIP_UNCOMPRESSED_SIZE,
} from './document-preview-limits.js';
import { DocumentPreviewError } from './document-preview-error.js';

type ZipEntryWithSizes = JSZip.JSZipObject & {
  _data?: { compressedSize?: number; uncompressedSize?: number };
};

export async function loadCheckedZip(buffer: Buffer): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch {
    throw new DocumentPreviewError('DOCUMENT_INVALID', '文档压缩结构损坏，无法预览，请下载后查看');
  }

  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', '文档内部文件数量过多，无法安全预览');
  }

  let totalUncompressed = 0;
  for (const entry of entries as ZipEntryWithSizes[]) {
    if (entry.dir) continue;
    const compressed = Math.max(1, entry._data?.compressedSize ?? 0);
    const uncompressed = entry._data?.uncompressedSize ?? 0;
    if (uncompressed > MAX_ZIP_ENTRY_SIZE) {
      throw new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', '文档内部单个内容过大，无法安全预览');
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_SIZE || uncompressed / compressed > MAX_ZIP_COMPRESSION_RATIO) {
      throw new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', '文档解压后内容过大，无法安全预览');
    }
  }
  return zip;
}
