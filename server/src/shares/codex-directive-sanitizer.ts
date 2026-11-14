const KNOWN_DIRECTIVE_PATTERN = /(?:::codex-inline-vis|::artifact-template|:codex-file-citation)\{[^}\r\n]*\}/g;
const ATTRIBUTE_PATTERN = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(["'])(.*?)\2/g;

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[match[1]] = match[3];
  }
  return attributes;
}

function safeLabel(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/[\r\n\[\]]/g, ' ').trim();
  return normalized ? normalized.slice(0, 120) : fallback;
}

function fileName(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
  return safeLabel(name, fallback);
}

export function sanitizeCodexFileDirectives(content: string): string {
  return content.replace(KNOWN_DIRECTIVE_PATTERN, (directive) => {
    const openBrace = directive.indexOf('{');
    const name = directive.slice(0, openBrace);
    const attributes = parseAttributes(directive.slice(openBrace + 1, -1));
    if (name === ':codex-file-citation') {
      return `[文件：${fileName(attributes.path, '未命名文件')}]`;
    }
    if (name === '::codex-inline-vis') {
      return `[可视化：${fileName(attributes.file, '未命名页面')}]`;
    }
    return `[模板：${safeLabel(attributes.display_name || attributes.skill_name, '未命名模板')}]`;
  });
}
