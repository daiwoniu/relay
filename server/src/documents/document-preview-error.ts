export type DocumentPreviewErrorCode =
  | 'DOCUMENT_ENCRYPTED'
  | 'DOCUMENT_FORMAT_UNSUPPORTED'
  | 'DOCUMENT_INVALID'
  | 'DOCUMENT_LIMIT_EXCEEDED'
  | 'DOCUMENT_TIMEOUT'
  | 'DOCUMENT_CHANGED'
  | 'SHEET_NOT_FOUND';

export class DocumentPreviewError extends Error {
  constructor(
    readonly code: DocumentPreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentPreviewError';
  }
}
export function normalizeDocumentPreviewError(error: unknown): DocumentPreviewError {
  if (error instanceof DocumentPreviewError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypt|password/i.test(message)) {
    return new DocumentPreviewError('DOCUMENT_ENCRYPTED', '暂不支持加密或需要密码的文档预览，请下载后查看');
  }
  return new DocumentPreviewError('DOCUMENT_INVALID', '文档损坏或格式不符，无法预览，请下载后使用原应用打开');
}
