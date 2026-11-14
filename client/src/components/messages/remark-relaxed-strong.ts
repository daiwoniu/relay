interface MarkdownNode {
  type: string;
  value?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: MarkdownNode[];
}

const SKIPPED_PARENTS = new Set(['code', 'inlineCode', 'link', 'linkReference', 'html']);

function splitRelaxedStrong(node: MarkdownNode, source: string): MarkdownNode[] | null {
  const value = node.value || '';
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined || source.slice(start, end) !== value) return null;

  const opening = value.indexOf('**');
  if (opening < 0 || value[opening - 1] === '*' || value[opening + 2] === '*') return null;
  const closing = value.indexOf('**', opening + 2);
  if (closing < 0 || value[closing - 1] === '*' || value[closing + 2] === '*') return null;
  if (value.indexOf('**', closing + 2) >= 0) return null;

  const children: MarkdownNode[] = [];
  if (opening > 0) children.push({ type: 'text', value: value.slice(0, opening) });
  children.push({
    type: 'strong',
    children: [{ type: 'text', value: value.slice(opening + 2, closing) }],
  });
  if (closing + 2 < value.length) children.push({ type: 'text', value: value.slice(closing + 2) });
  return children;
}

function transform(node: MarkdownNode, source: string): void {
  if (!node.children || SKIPPED_PARENTS.has(node.type)) return;
  const children: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') children.push(...(splitRelaxedStrong(child, source) || [child]));
    else {
      transform(child, source);
      children.push(child);
    }
  }
  node.children = children;
}

/** Adds the narrow paired-** fallback that CommonMark leaves as plain text. */
export default function remarkRelaxedStrong() {
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    if (typeof file.value === 'string') transform(tree, file.value);
  };
}
