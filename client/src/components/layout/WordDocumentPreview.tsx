import type { WordDocumentPreviewDto } from '../../generated/relay-contracts';

export default function WordDocumentPreview({
  document,
}: {
  document: WordDocumentPreviewDto;
}) {
  const unit = document.countUnit === 'pages' ? '页' : '个内容块';
  return (
    <div className="min-h-full">
      <div className={`document-preview-notice sticky top-0 z-10${document.truncated || document.omittedImageCount > 0 ? ' is-limited' : ''}`}>
        <span>
          共 <strong>{document.totalCount} {unit}</strong>
          {document.truncated ? <>，<strong>仅展示前 {document.displayedCount} {unit}</strong>，建议下载后查看完整内容</> : '，已全部展示'}
          {document.omittedImageCount > 0 ? <>；<strong>{document.omittedImageCount} 张图片因安全限制未加载</strong></> : ''}
        </span>
      </div>
      <article className="word-document-preview" dangerouslySetInnerHTML={{ __html: document.html }} />
    </div>
  );
}
