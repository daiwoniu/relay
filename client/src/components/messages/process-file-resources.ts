import type { ProcessStep } from '../../stores/chat';
import type { ProcessFlowContext } from './process-flow-model';
import { describeFileChanges } from '../../stores/process-event-summary.ts';

export interface ProcessFileResource { path: string; name: string; directory: string; action: string; deleted: boolean; thumbnailAllowed: boolean }

export function areProcessFilesEqual(previous: ProcessFileResource[], next: ProcessFileResource[]): boolean {
  return previous === next || previous.length === next.length && previous.every((file, index) => {
    const other = next[index];
    return file.path === other.path && file.name === other.name && file.directory === other.directory
      && file.action === other.action && file.deleted === other.deleted && file.thumbnailAllowed === other.thumbnailAllowed;
  });
}
type Context = Pick<ProcessFlowContext, 'projectPath' | 'readOnly'>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const absolute = (value: string) => /^(?:[a-z]:\/|\/)/i.test(value);
const key = (value: string) => /^(?:[a-z]:|\/\/)/i.test(value) ? value.toLowerCase() : value;

function normalize(value: string): string {
  if (value === '/' || /^[a-z]:\/$/i.test(value)) return value;
  const unc = value.startsWith('//');
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '.') continue;
    if (part === '..') { if (parts.length <= (unc ? 3 : 1)) return ''; parts.pop(); }
    else if (part || !parts.length) parts.push(part);
  }
  const joined = (unc ? '/' : '') + parts.join('/');
  return joined === '/' || /^[a-z]:\/$/i.test(joined) ? joined : joined.replace(/\/$/, '');
}

function resolve(path: string, base: string): string {
  const raw = path.replace(/\\/g, '/');
  if (!raw || /[\u0000-\u001f\u007f*$`]/.test(raw)
    || (/^[a-z][\w+.-]*:/i.test(raw) && !/^[a-z]:\//i.test(raw))) return '';
  if (!absolute(raw) && !absolute(base)) return '';
  return normalize(absolute(raw) ? raw : `${base.replace(/\/$/, '')}/${raw}`);
}

export function getProcessFileResources(step: ProcessStep, context: Context): ProcessFileResource[] {
  if (context.readOnly) return [];
  const d = step.details;
  const root = normalize(text(context.projectPath).replace(/\\/g, '/'));
  let input: Record<string, unknown> = {};
  try { const value = d.arguments ?? d.input ?? d.params; input = record(typeof value === 'string' ? JSON.parse(value) : value); } catch { /* Truncated historical arguments are not a reliable source. */ }
  const cwd = text(d.cwd) || text(input.workdir) || text(input.cwd);
  const base = cwd ? resolve(cwd, root) : root;
  const files = new Map<string, ProcessFileResource>();
  const add = (raw: string, action: string) => {
    if (/[\\/]$/.test(raw)) return;
    const path = resolve(raw, base);
    if (!path) return;
    const deleted = action === '删除';
    const previous = files.get(key(path));
    const name = path.split('/').pop() || path;
    files.set(key(path), { path, name, directory: path.slice(0, -(name.length + 1)), action,
      deleted: deleted || Boolean(previous?.deleted),
      thumbnailAllowed: step.status === 'completed' && absolute(root) && key(path).startsWith(`${key(root).replace(/\/$/, '')}/`),
    });
  };
  const changes = (details: Record<string, unknown>) => {
    const entries = [text(details.path) || text(details.filePath) || text(details.file),
      ...['changes', 'files', 'fileChanges', 'reportedFileChanges'].flatMap(k => Array.isArray(details[k]) ? details[k] as unknown[] : [])];
    for (const entry of entries) {
      const value = record(entry);
      const raw = typeof entry === 'string' ? entry : text(value.path) || text(value.filePath) || text(value.file);
      if (!raw) continue;
      const { action } = describeFileChanges({ changeType: details.changeType, action: details.action, kind: details.kind, changes: [entry] });
      add(raw, action);
    }
  };
  if (step.type === 'fileChange') changes(d);
  else if (step.type === 'imageView') add(text(d.path) || text(d.filePath), '查看');
  else if (step.type === 'imageGeneration' && step.status === 'completed') add(text(d.savedPath), '生成');
  else if (step.type === 'dynamicToolCall') {
    const tool = text(d.tool) || text(d.toolName) || text(d.name);
    if (/^mcp[_.]/i.test(tool) || d.server || d.serverName) return [];
    if (tool === 'relay_report_file_changes' && step.status === 'completed' && d.success === true) changes(Array.isArray(d.fileChanges) ? { fileChanges: d.fileChanges } : input);
    else if (/^(?:read|read_file|read_text_file|get_file|view_image)$/i.test(tool.split('.').pop() || '') && d.readOnlyHint !== false) {
      add(text(input.path) || text(input.filePath) || text(input.file_path) || text(input.filename), '查看');
    }
  }
  return [...files.values()];
}
