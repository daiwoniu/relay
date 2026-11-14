export type CodexFileReferenceKind = 'file' | 'visualization' | 'template';
import type { HtmlPreviewMode } from '../../stores/chat';

export interface CodexFileReferenceData {
  kind: CodexFileReferenceKind;
  path: string;
  label: string;
  locator?: string;
  preferredMode: HtmlPreviewMode;
}

export type CodexFileReferencePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const INTERNAL_REFERENCE_PREFIX = 'codex-file-ref:';
const INLINE_CITATION_PREFIX = ':codex-file-citation{';
const FOLLOWUP_PREFIX = ':codex-followup[';
const DIRECTIVE_PATTERN = /^(:codex-file-citation|::codex-inline-vis|::artifact-template)\{([\s\S]*)\}$/;

const ATTRIBUTE_WHITELISTS: Record<string, ReadonlySet<string>> = {
  ':codex-file-citation': new Set([
    'path', 'purpose', 'artifact_kind', 'page_number', 'line_start', 'line_end',
    'slide_number', 'slide_id', 'object_id', 'object_kind', 'label', 'sheet', 'range',
  ]),
  '::codex-inline-vis': new Set(['file']),
  '::artifact-template': new Set([
    'skill_name', 'skill_directory', 'display_name', 'artifact_kind',
  ]),
};

function parseQuotedAttributes(source: string, allowedKeys: ReadonlySet<string>): Record<string, string> | null {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] || '')) index += 1;
    if (index >= source.length) break;

    const keyMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(index));
    if (!keyMatch) return null;
    const key = keyMatch[0];
    if (!allowedKeys.has(key) || Object.prototype.hasOwnProperty.call(attributes, key)) return null;
    index += key.length;

    while (/\s/.test(source[index] || '')) index += 1;
    if (source[index] !== '=') return null;
    index += 1;
    while (/\s/.test(source[index] || '')) index += 1;

    const quote = source[index];
    if (quote !== '"' && quote !== "'") return null;
    index += 1;
    let value = '';
    let closed = false;
    while (index < source.length) {
      const char = source[index];
      if (char === quote) {
        index += 1;
        closed = true;
        break;
      }
      if (char === '\\' && source[index + 1] === quote) {
        value += source[index + 1];
        index += 2;
        continue;
      }
      value += char;
      index += 1;
    }
    if (!closed || !value.trim()) return null;
    attributes[key] = value;
    if (index < source.length && !/\s/.test(source[index])) return null;
  }
  return attributes;
}

function getFileName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || path;
}

function buildLocator(attributes: Record<string, string>): string | undefined {
  const page = Number.parseInt(attributes.page_number || '', 10);
  if (Number.isInteger(page) && page > 0) return `第 ${page} 页`;

  const slide = Number.parseInt(attributes.slide_number || '', 10);
  if (Number.isInteger(slide) && slide > 0) {
    return attributes.label?.trim()
      ? `第 ${slide} 张幻灯片 · ${attributes.label.trim()}`
      : `第 ${slide} 张幻灯片`;
  }

  const sheet = attributes.sheet?.trim();
  if (sheet) {
    const detail = attributes.range?.trim() || attributes.label?.trim();
    return detail ? `工作表“${sheet}” · ${detail}` : `工作表“${sheet}”`;
  }

  const start = Number.parseInt(attributes.line_start || '', 10);
  const end = Number.parseInt(attributes.line_end || '', 10);
  if (!Number.isInteger(start) || start <= 0) return undefined;
  return Number.isInteger(end) && end >= start ? `第 ${start}–${end} 行` : `第 ${start} 行`;
}

function isAbsoluteFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$)|\/)/.test(normalized);
}

export function resolveCodexFileReferencePathResult(
  filePath: string,
  projectPath?: string,
): CodexFileReferencePathResult {
  const trimmed = filePath.trim();
  if (!trimmed || /[\u0000-\u001F\u007F]/.test(trimmed)) return { ok: false, reason: '文件路径无效' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { ok: false, reason: '文件路径协议无效' };
  }
  if (isAbsoluteFilePath(trimmed)) return { ok: true, path: trimmed };
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.split('/').includes('..')) return { ok: false, reason: '文件路径不在当前项目内' };
  if (!projectPath) return { ok: false, reason: '当前消息缺少项目路径' };
  const root = projectPath.replace(/[\\/]+$/, '');
  const path = /^[A-Za-z]:[\\/]/.test(root) || root.includes('\\')
    ? `${root}\\${normalized.replace(/\//g, '\\')}`
    : `${root}/${normalized}`;
  return { ok: true, path };
}

export function resolveCodexFileReferencePath(filePath: string, projectPath?: string): string {
  const result = resolveCodexFileReferencePathResult(filePath, projectPath);
  if (!result.ok) throw new Error(result.reason);
  return result.path;
}

function appendSkillFile(directory: string): string {
  const trimmed = directory.replace(/[\\/]+$/, '');
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return `${trimmed}${separator}SKILL.md`;
}

export function parseCodexDirective(source: string): CodexFileReferenceData | null {
  const match = DIRECTIVE_PATTERN.exec(source.trim());
  if (!match) return null;
  const [, name, attributeSource] = match;
  const attributes = parseQuotedAttributes(attributeSource, ATTRIBUTE_WHITELISTS[name]);
  if (!attributes) return null;

  if (name === ':codex-file-citation') {
    const path = attributes.path?.trim();
    if (!path) return null;
    return {
      kind: 'file',
      path,
      label: getFileName(path),
      ...(buildLocator(attributes) ? { locator: buildLocator(attributes) } : {}),
      preferredMode: 'source',
    };
  }

  if (name === '::codex-inline-vis') {
    const path = attributes.file?.trim();
    if (!path) return null;
    return {
      kind: 'visualization',
      path,
      label: getFileName(path),
      preferredMode: 'visualization',
    };
  }

  const directory = attributes.skill_directory?.trim();
  const label = attributes.display_name?.trim() || attributes.skill_name?.trim();
  if (!directory || !label) return null;
  return {
    kind: 'template',
    path: appendSkillFile(directory),
    label,
    preferredMode: 'source',
  };
}

function isCodexFileReferenceData(value: unknown): value is CodexFileReferenceData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CodexFileReferenceData>;
  return (candidate.kind === 'file' || candidate.kind === 'visualization' || candidate.kind === 'template')
    && typeof candidate.path === 'string'
    && candidate.path.length > 0
    && typeof candidate.label === 'string'
    && candidate.label.length > 0
    && (candidate.locator === undefined || typeof candidate.locator === 'string')
    && (candidate.preferredMode === 'source' || candidate.preferredMode === 'visualization');
}

export function encodeCodexFileReference(reference: CodexFileReferenceData): string {
  return `${INTERNAL_REFERENCE_PREFIX}${encodeURIComponent(JSON.stringify(reference))}`;
}

export function decodeCodexFileReference(href: string): CodexFileReferenceData | null {
  if (!href.startsWith(INTERNAL_REFERENCE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(href.slice(INTERNAL_REFERENCE_PREFIX.length)));
    return isCodexFileReferenceData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function referenceLink(reference: CodexFileReferenceData): MarkdownNode {
  return {
    type: 'link',
    url: encodeCodexFileReference(reference),
    children: [{ type: 'text', value: reference.label }],
  };
}

function parseFollowupAt(value: string, start: number): { end: number; text: string } | null {
  const titleEnd = value.indexOf(']', start + FOLLOWUP_PREFIX.length);
  if (titleEnd < 0 || value[titleEnd + 1] !== '{') return null;
  const title = value.slice(start + FOLLOWUP_PREFIX.length, titleEnd).trim();
  if (!title || /[\r\n]/.test(title)) return null;

  let quote: string | null = null;
  for (let index = titleEnd + 2; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\r' || char === '\n') return null;
    if (quote) {
      if (char === '\\' && value[index + 1] === quote) {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '}') continue;
    const attributes = parseQuotedAttributes(value.slice(titleEnd + 2, index), new Set(['prompt']));
    const prompt = attributes?.prompt?.trim();
    if (!prompt) return null;
    return { end: index + 1, text: title === prompt ? title : `${title}：${prompt}` };
  }
  return null;
}

function transformInlineDirectives(value: string): MarkdownNode[] | null {
  const result: MarkdownNode[] = [];
  let cursor = 0;
  let searchFrom = 0;
  let changed = false;
  while (searchFrom < value.length) {
    const citationStart = value.indexOf(INLINE_CITATION_PREFIX, searchFrom);
    const followupStart = value.indexOf(FOLLOWUP_PREFIX, searchFrom);
    const start = citationStart < 0 ? followupStart : followupStart < 0 ? citationStart : Math.min(citationStart, followupStart);
    if (start < 0) break;
    if (start === followupStart) {
      const followup = parseFollowupAt(value, start);
      if (!followup) {
        searchFrom = start + 1;
        continue;
      }
      if (start > cursor) result.push({ type: 'text', value: value.slice(cursor, start) });
      result.push({ type: 'text', value: followup.text });
      cursor = followup.end;
      searchFrom = cursor;
      changed = true;
      continue;
    }
    const end = value.indexOf('}', start + INLINE_CITATION_PREFIX.length);
    if (end < 0) break;
    const reference = parseCodexDirective(value.slice(start, end + 1));
    if (!reference) {
      searchFrom = start + 1;
      continue;
    }
    if (start > cursor) result.push({ type: 'text', value: value.slice(cursor, start) });
    result.push(referenceLink(reference));
    cursor = end + 1;
    searchFrom = cursor;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < value.length) result.push({ type: 'text', value: value.slice(cursor) });
  return result;
}

const SKIPPED_PARENT_TYPES = new Set(['code', 'inlineCode', 'link', 'linkReference', 'html']);

function transformMarkdownNode(node: MarkdownNode): void {
  if (!node.children || SKIPPED_PARENT_TYPES.has(node.type)) return;

  if (node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'text') {
    const source = node.children[0].value || '';
    const trimmed = source.trim();
    if (trimmed.startsWith('::')) {
      const standalone = parseCodexDirective(trimmed);
      if (standalone && standalone.kind !== 'file') {
        node.children = [referenceLink(standalone)];
        return;
      }
    }
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      nextChildren.push(...(transformInlineDirectives(child.value || '') || [child]));
      continue;
    }
    transformMarkdownNode(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkCodexFileDirectives() {
  return (tree: MarkdownNode) => {
    transformMarkdownNode(tree);
  };
}
