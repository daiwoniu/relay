interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const HTML_BREAK_TAG = /^<br\s*\/?>$/i;

function replaceHtmlBreaks(node: MarkdownNode): void {
  if (!node.children) return;

  for (const child of node.children) {
    if (child.type === 'html' && HTML_BREAK_TAG.test(child.value || '')) {
      child.type = 'break';
      delete child.value;
      continue;
    }
    replaceHtmlBreaks(child);
  }
}

/** 只启用安全的 HTML br 换行，不开放其他原始 HTML。 */
export default function remarkHtmlBreak() {
  return (tree: MarkdownNode) => replaceHtmlBreaks(tree);
}
