import { resolveCodexFileReferencePathResult } from '../messages/codex-file-directives.ts';
import { normalizeMessageFilePath } from '../messages/file-preview-path.ts';

export function resolveFeishuReplyPreviewPath(value: string, projectPath?: string) {
  if (!projectPath) return undefined;
  let source = value.trim();
  if (/^file:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (url.hostname && url.hostname !== 'localhost') return undefined;
      source = url.pathname;
    } catch { return undefined; }
  }
  const path = normalizeMessageFilePath(source).replace(/:\d+$/, '').replace(/\\/g, '/');
  if (path.split('/').includes('..') || !/\.[\p{L}\p{N}]{1,12}$/u.test(path)) return undefined;
  const result = resolveCodexFileReferencePathResult(path, projectPath);
  if (!result.ok) return undefined;
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  const target = result.path.replace(/\\/g, '/');
  const windows = /^(?:[a-z]:\/|\/\/)/i.test(root);
  const within = windows ? target.toLowerCase().startsWith(root.toLowerCase()) : target.startsWith(root);
  return within ? result.path : undefined;
}
