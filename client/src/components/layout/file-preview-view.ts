import type { RightPanelTab } from '../../stores/chat';
import { isLargeCodePreview } from './file-preview-lines.ts';

export type FilePreviewView = 'preview' | 'source' | 'git-diff';

export function isMarkdownPreview(tab: Pick<RightPanelTab, 'language'> | undefined): boolean {
  return /^(md|markdown|mdown|mkd)$/i.test(tab?.language ?? '');
}

export function supportsRenderedPreview(tab: RightPanelTab): boolean {
  return isMarkdownPreview(tab) || tab.language === 'html' || tab.language === 'htm';
}

export function getFilePreviewView(tab: RightPanelTab): FilePreviewView {
  if (!tab.language) return 'source';
  if (tab.previewView === 'git-diff' && !tab.textPreviewTruncated) return 'git-diff';
  if (!supportsRenderedPreview(tab) || isLargeCodePreview(tab.contentSize) || tab.textPreviewTruncated) return 'source';
  if (tab.previewView) return tab.previewView;
  if (isMarkdownPreview(tab)) return 'preview';
  return tab.htmlPreviewMode === 'visualization' ? 'preview' : 'source';
}

export type MarkdownReference = { kind: 'anchor' | 'external' | 'file' | 'blocked'; target: string };

/** Resolve locally without widening file access; the normal filesystem API still authorizes each target. */
export function resolveMarkdownReference(sourcePath: string, reference: string): MarkdownReference {
  const value = reference.trim();
  if (!value) return { kind: 'blocked', target: '' };
  if (value.startsWith('#')) return { kind: 'anchor', target: value };
  if (/^(https?:|mailto:)/i.test(value)) return { kind: 'external', target: value };
  if (value.startsWith('//')) return { kind: 'external', target: `https:${value}` };
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return { kind: 'blocked', target: '' };
  }
  let decoded: string;
  try { decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]); }
  catch { return { kind: 'blocked', target: '' }; }
  if (!decoded || /[\x00-\x1f\x7f]/.test(decoded)) return { kind: 'blocked', target: '' };
  const source = sourcePath.replace(/\\/g, '/');
  const path = decoded.replace(/\\/g, '/');
  const absolute = /^(?:[a-z]:\/|\/)/i.test(path);
  const combined = absolute ? path : `${source.slice(0, source.lastIndexOf('/') + 1)}${path}`;
  const prefix = combined.startsWith('//') ? '//' : combined.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    const last = parts[parts.length - 1];
    if (part === '..' && parts.length && !last.endsWith(':') && last !== '..') parts.pop();
    else if (part !== '..' || (!prefix && !/^[a-z]:/i.test(parts[0] ?? ''))) parts.push(part);
  }
  return { kind: 'file', target: prefix + parts.join('/') };
}

export function markdownHeadingId(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}

type MarkdownNode = { type?: string; value?: string; alt?: string; children?: MarkdownNode[]; data?: { hProperties?: Record<string, unknown> } };

export function markdownHeadingIds() {
  return (tree: MarkdownNode) => {
    const used = new Set<string>();
    const text = (node: MarkdownNode): string => node.value ?? node.alt ?? node.children?.map(text).join('') ?? '';
    const visit = (node: MarkdownNode) => {
      if (node.type === 'heading') {
        const base = markdownHeadingId(text(node)) || 'section';
        let id = base;
        for (let suffix = 1; used.has(id); suffix += 1) id = `${base}-${suffix}`;
        used.add(id);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function markdownLinkedImages() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode, linked = false) => {
      if (linked && (node.type === 'image' || node.type === 'imageReference')) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataPreviewLinkedImage: true } };
      }
      node.children?.forEach((child) => visit(child, linked || node.type === 'link' || node.type === 'linkReference'));
    };
    visit(tree);
  };
}
