import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useFilePreview } from '../messages/useFilePreview';
import { resolveFeishuReplyPreviewPath } from './feishu-reply-preview-path';

const prosePaths = /(https?:\/\/[^\s<>]+|(?<![\w:/\\])(?:\/?[a-z]:[\\/]|\/(?!\/)|[\p{L}\p{N}_.-]+[\\/])[^\s<>，。；、！？）]+)/giu;

export default function FeishuReplyMarkdown({ body, projectPath }: { body: string; projectPath?: string }) {
  const openFilePreview = useFilePreview(projectPath);
  const preview = (path: string, label: ReactNode) => <button type="button" className="md-link-file" data-file-preview-trigger
    title={path} onClick={() => void openFilePreview(path)}>{label}</button>;
  const prose = (children: ReactNode) => Children.map(children, child => {
    if (!projectPath) return child;
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === 'code' && typeof child.props.children === 'string') {
      const path = resolveFeishuReplyPreviewPath(child.props.children, projectPath);
      return path ? preview(path, child) : child;
    }
    if (typeof child !== 'string') return child;
    return child.split(prosePaths).map((part, index) => {
      if (index % 2 === 0) return part;
      const reference = part.replace(/[,.;)\]]+$/, '');
      const path = resolveFeishuReplyPreviewPath(reference, projectPath);
      return path ? <Fragment key={index}>{preview(path, reference)}{part.slice(reference.length)}</Fragment> : part;
    });
  });
  return <div className="feishu-reply-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]}
    urlTransform={(url, key) => key === 'href' && resolveFeishuReplyPreviewPath(url, projectPath) ? url : defaultUrlTransform(url)}
    components={{
      img: ({ alt }) => <span>{alt || '图片'}</span>,
      a: ({ children, href }) => {
        const path = href && resolveFeishuReplyPreviewPath(href, projectPath);
        if (path) return preview(path, children);
        return href && /^(?:https?:\/\/|mailto:|tel:|#)/i.test(href)
          ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
      },
      p: ({ children }) => <p>{prose(children)}</p>,
      li: ({ children }) => <li>{prose(children)}</li>,
      td: ({ children, align }) => <td align={align}>{prose(children)}</td>,
      th: ({ children, align }) => <th align={align}>{prose(children)}</th>,
    }}>{body}</ReactMarkdown></div>;
}
