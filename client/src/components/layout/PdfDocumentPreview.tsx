import type { PdfDocumentPreviewDto } from '../../generated/relay-contracts';
import PreviewState from './PreviewState';

export default function PdfDocumentPreview({
  document,
  onDownload,
  downloading = false,
}: {
  document: PdfDocumentPreviewDto & { previewUrl: string };
  onDownload: () => void;
  downloading?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`document-preview-notice${document.truncated ? ' is-limited' : ''}`}>
        <span>共 <strong>{document.totalPages} 页</strong>{document.truncated ? <>，<strong>仅展示前 {document.displayedPages} 页</strong>，建议下载后查看完整内容</> : '，已全部展示'}</span>
        <span className="document-preview-actions">
          <a href={document.previewUrl} target="_blank" rel="noreferrer">新标签打开预览</a>
        </span>
      </div>
      <object data={document.previewUrl} type="application/pdf" className="min-h-0 flex-1 bg-white" aria-label="PDF 文档预览">
        <PreviewState
          tone="warning"
          title="当前浏览器无法嵌入 PDF 预览"
          description={`可在新标签中打开前 ${document.displayedPages} 页，或保存完整文件。`}
          action={<div className="flex flex-wrap justify-center gap-2"><a className="workspace-preview-state__button" href={document.previewUrl} target="_blank" rel="noreferrer">新标签打开</a><button className="workspace-preview-state__button" type="button" disabled={downloading} aria-busy={downloading} onClick={onDownload}>{downloading ? '正在下载…' : '下载原文件'}</button></div>}
        />
      </object>
    </div>
  );
}
