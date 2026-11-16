import Tooltip from '../ui/Tooltip';
import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useFilePreview } from '../messages/useFilePreview';
import { markdownHeadingIds, markdownLinkedImages, resolveMarkdownReference } from './file-preview-view';

export default function MarkdownFilePreview({ content, sourcePath }: { content: string; sourcePath: string }) {
  const openFile = useFilePreview();
  const components = useMemo<Components>(() => {
    return {
      a: ({ href, children }) => {
        const link = resolveMarkdownReference(sourcePath, href ?? '');
        if (link.kind === 'blocked') return <span>{children}</span>;
        if (link.kind === 'file') return <Tooltip content={link.target} asChild><button type="button" className="md-link-file preview-file-link" onClick={() => void openFile(link.target)}>{children}</button></Tooltip>;
        if (link.kind === 'anchor') return <a href={link.target} onClick={(event) => {
          event.preventDefault();
          let id: string;
          try { id = decodeURIComponent(link.target.slice(1)); } catch { return; }
          const article = event.currentTarget.closest('article');
          const heading = [...(article?.querySelectorAll('[id]') ?? [])].find((item) => item.id === id);
          heading?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        }}>{children}</a>;
        return <a href={link.target} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      // Local images use the same authorized file-opening flow; remote images do not load implicitly.
      img: ({ src, alt, node }) => {
        if (node?.properties.dataPreviewLinkedImage) return <span className="preview-image-link">{alt || '图片链接'}</span>;
        const image = resolveMarkdownReference(sourcePath, src ?? '');
        if (image.kind === 'file') return <Tooltip content={image.target} asChild><button type="button" className="md-link-file preview-file-link preview-image-link" onClick={() => void openFile(image.target)}>查看图片：{alt || image.target.split('/').pop()}</button></Tooltip>;
        if (image.kind === 'external') return <a className="preview-image-link" href={image.target} target="_blank" rel="noopener noreferrer">查看图片：{alt || '外部图片'}</a>;
        return <span>{alt || '图片不可用'}</span>;
      },
    };
  }, [openFile, sourcePath]);
  return <article className="markdown-body workspace-preview-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, markdownHeadingIds, markdownLinkedImages]} rehypePlugins={[rehypeHighlight]} components={components} urlTransform={(url) => resolveMarkdownReference(sourcePath, url).kind === 'blocked' ? '' : url}>{content}</ReactMarkdown></article>;
}
