type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectText(value: unknown, seen: WeakSet<object>): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry, seen)).join('');
  }
  if (!isRecord(value) || seen.has(value)) return '';
  seen.add(value);

  let text = '';
  if (typeof value.value === 'string') text = value.value;
  else if (Array.isArray(value.children)) text = collectText(value.children, seen);
  else if (isRecord(value.props) && 'children' in value.props) {
    text = collectText(value.props.children, seen);
  }
  seen.delete(value);
  return text;
}

export function extractMarkdownCodeText(node: unknown, children: unknown): string {
  if (isRecord(node) && Array.isArray(node.children)) {
    return collectText(node.children, new WeakSet());
  }
  return collectText(children, new WeakSet());
}
