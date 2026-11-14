import fs from 'node:fs';
import path from 'node:path';
import {
  RELAY_FILE_CHANGE_REPORT_TOOL,
  extractReportedFileChanges,
  parseRelayFileChangeReport,
} from './file-change-report.js';

export type ChangedFileType = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  path: string;
  changeType: ChangedFileType;
  size?: number;
  external?: true;
}

type FileOperation = ChangedFile;
type UnknownRecord = Record<string, unknown>;
const MAX_CHANGED_FILES = 500;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeChangeType(value: unknown, fallback: ChangedFileType = 'modified'): ChangedFileType {
  const normalizedValue = isRecord(value) ? value.type : value;
  const text = toText(normalizedValue).toLowerCase();
  if (/^(?:add|added|create|created|new)$/.test(text)) return 'added';
  if (/^(?:delete|deleted|remove|removed)$/.test(text)) return 'deleted';
  if (/^(?:modify|modified|update|updated|edit|edited|write|written)$/.test(text)) return 'modified';
  return fallback;
}

function isAbsolutePath(value: string): boolean {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function normalizeChangedPath(value: unknown, projectRoot?: string): string | null {
  const raw = toText(value).replace(/^['"]|['"]$/g, '');
  if (!raw || raw.length > 4096 || /[\u0000-\u001F\u007F]/.test(raw) || /[\\/]$/.test(raw)) return null;

  let relative = raw;
  if (isAbsolutePath(raw)) {
    if (!projectRoot) return null;
    const pathApi = path.win32.isAbsolute(raw) || path.win32.isAbsolute(projectRoot) ? path.win32 : path.posix;
    const candidate = pathApi.relative(pathApi.resolve(projectRoot), pathApi.resolve(raw));
    if (!candidate || candidate === '..' || candidate.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(candidate)) return null;
    relative = candidate;
  }

  const normalized = path.posix.normalize(relative.replaceAll('\\', '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  return normalized;
}

function resolveRealPathAllowMissing(targetPath: string): string | null {
  let ancestor = path.resolve(targetPath);
  const suffix: string[] = [];
  while (true) {
    try {
      const realAncestor = fs.realpathSync(ancestor);
      return path.resolve(realAncestor, ...suffix);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return null;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}

function normalizeTrustedFileChangePath(
  value: unknown,
  projectRoot?: string,
): Pick<FileOperation, 'path' | 'external'> | null {
  const raw = toText(value).replace(/^['"]|['"]$/g, '');
  if (!raw
    || raw.length > 4096
    || /[\u0000-\u001F\u007F]/.test(raw)
    || /[\\/]$/.test(raw)) return null;

  if (!isAbsolutePath(raw)) {
    const projectPath = normalizeChangedPath(raw, projectRoot);
    return projectPath ? { path: projectPath } : null;
  }
  if (!projectRoot) return null;

  if (path.isAbsolute(raw) && path.isAbsolute(projectRoot)) {
    const realProjectRoot = resolveRealPathAllowMissing(projectRoot);
    const realCandidate = resolveRealPathAllowMissing(raw);
    if (realProjectRoot && realCandidate) {
      const relative = path.relative(realProjectRoot, realCandidate);
      if (!relative) return null;
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
        return normalized && normalized !== '.' ? { path: normalized } : null;
      }
      return { path: path.normalize(realCandidate), external: true };
    }
  }

  const pathApi = path.win32.isAbsolute(raw) || path.win32.isAbsolute(projectRoot) ? path.win32 : path.posix;
  const absolutePath = pathApi.normalize(pathApi.resolve(raw));
  const projectPathAbsolute = pathApi.resolve(projectRoot);
  const relative = pathApi.relative(projectPathAbsolute, absolutePath);
  if (!relative || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative))) return null;
  return { path: absolutePath, external: true };
}

function getPathValue(source: UnknownRecord): unknown {
  return source.path ?? source.filePath ?? source.file;
}

function getChangeValue(source: UnknownRecord): unknown {
  return source.changeType ?? source.action ?? source.kind ?? source.type;
}

function getMovePath(source: UnknownRecord): unknown {
  const kind = isRecord(source.kind) ? source.kind : undefined;
  return source.move_path ?? source.movePath ?? kind?.move_path ?? kind?.movePath;
}

function pushOperation(
  operations: FileOperation[],
  filePath: unknown,
  changeValue: unknown,
  projectRoot?: string,
  fallback: ChangedFileType = 'modified',
  allowExternal = false,
): void {
  const normalized = allowExternal
    ? normalizeTrustedFileChangePath(filePath, projectRoot)
    : (() => {
      const normalizedPath = normalizeChangedPath(filePath, projectRoot);
      return normalizedPath ? { path: normalizedPath } : null;
    })();
  if (!normalized) return;
  operations.push({ ...normalized, changeType: normalizeChangeType(changeValue, fallback) });
}

function extractCollection(
  operations: FileOperation[],
  value: unknown,
  defaultChange: unknown,
  projectRoot?: string,
  allowExternal = false,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') pushOperation(operations, entry, defaultChange, projectRoot, 'modified', allowExternal);
      else if (isRecord(entry)) {
        const filePath = getPathValue(entry);
        const changeValue = getChangeValue(entry) ?? defaultChange;
        const movePath = getMovePath(entry);
        if (movePath && normalizeChangeType(changeValue) === 'modified') {
          pushOperation(operations, filePath, 'delete', projectRoot, 'modified', allowExternal);
          pushOperation(operations, movePath, 'add', projectRoot, 'modified', allowExternal);
        } else {
          pushOperation(operations, filePath, changeValue, projectRoot, 'modified', allowExternal);
        }
      }
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [filePath, details] of Object.entries(value)) {
    const changeValue = isRecord(details) ? getChangeValue(details) : details;
    const movePath = isRecord(details) ? getMovePath(details) : undefined;
    if (movePath && normalizeChangeType(changeValue ?? defaultChange) === 'modified') {
      pushOperation(operations, filePath, 'delete', projectRoot, 'modified', allowExternal);
      pushOperation(operations, movePath, 'add', projectRoot, 'modified', allowExternal);
    } else {
      pushOperation(operations, filePath, changeValue ?? defaultChange, projectRoot, 'modified', allowExternal);
    }
  }
}

function extractFileChange(item: UnknownRecord, source: UnknownRecord, projectRoot?: string): FileOperation[] {
  const operations: FileOperation[] = [];
  const defaultChange = getChangeValue(source) ?? getChangeValue(item);
  pushOperation(operations, getPathValue(source) ?? getPathValue(item), defaultChange, projectRoot, 'modified', true);
  for (const key of ['changes', 'files', 'fileChanges'] as const) {
    extractCollection(operations, source[key] ?? item[key], defaultChange, projectRoot, true);
  }
  return operations;
}

function extractApplyPatch(item: UnknownRecord, source: UnknownRecord, projectRoot?: string): FileOperation[] {
  const toolName = toText(source.name ?? source.toolName ?? source.tool ?? item.name ?? item.toolName ?? item.tool);
  if (!/^(?:apply_patch|applypatch)$/i.test(toolName)) return [];
  const input = source.arguments ?? source.input ?? source.params ?? item.arguments ?? item.input ?? item.params;
  const collectText = (value: unknown, depth = 0): string[] => {
    if (depth > 4) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap((entry) => collectText(entry, depth + 1));
    if (isRecord(value)) return Object.values(value).flatMap((entry) => collectText(entry, depth + 1));
    return [];
  };
  const text = collectText(input).join('\n');
  const operations: FileOperation[] = [];
  for (const match of text.matchAll(/^\*{3}\s+(Add|Update|Delete) File:\s*(.+?)\s*$/gim)) {
    pushOperation(operations, match[2], match[1], projectRoot);
  }
  return operations;
}

// ACP/ZCode 引擎没有原生 fileChange 事件，编辑类工具调用(如 Edit/Write/MultiEdit)的
// input.file_path 是唯一可靠证据；只认明确写文件的工具名，避免把读取类调用误报为修改。
const EDIT_TOOL_NAME_PATTERN = /^(?:edit|multiedit|write|writefile|createfile|notebookedit|applypatch)$/i;

function extractEditToolPaths(item: UnknownRecord, source: UnknownRecord, projectRoot?: string): FileOperation[] {
  const toolName = toText(source.toolName ?? source.tool ?? item.toolName ?? item.tool);
  if (!EDIT_TOOL_NAME_PATTERN.test(toolName)) return [];
  const input = isRecord(source.input) ? source.input : isRecord(item.input) ? item.input : undefined;
  const filePath = input ? input.file_path ?? getPathValue(input) : undefined;
  if (filePath === undefined) return [];
  const normalized = normalizeTrustedFileChangePath(filePath, projectRoot);
  if (!normalized) return [];
  return [{ ...normalized, changeType: 'modified' }];
}

function mergeOperation(current: ChangedFileType | undefined, next: ChangedFileType): ChangedFileType | null {
  if (!current) return next;
  if (current === 'added') return next === 'deleted' ? null : 'added';
  if (current === 'deleted') return next === 'deleted' ? 'deleted' : 'modified';
  return next === 'deleted' ? 'deleted' : 'modified';
}

function isAppliedItem(item: UnknownRecord, source: UnknownRecord): boolean {
  if ((source.success ?? item.success) === false) return false;
  const status = toText(source.status ?? item.status).replace(/[_-]/g, '').toLowerCase();
  return !['declined', 'failed', 'cancelled', 'canceled', 'rejected', 'inprogress', 'pending'].includes(status);
}

const HIGH_CONFIDENCE_WRITE_COMMAND_PATTERNS = [
  /\b(?:Set|Add|Clear)-Content\b/i,
  /\bOut-File\b/i,
  /\b(?:Copy|Move|Remove|Rename|New)-Item\b/i,
  /(?:^|[;&|]\s*|\s)(?:cp|mv|rm|mkdir|touch|install)\s+(?!-*(?:h|help|version)\b)/i,
  /(?:^|[;&|]\s*|\s)(?:copy|move|del|erase|ren|rename|mkdir|md)\s+(?!\/?(?:\?|h)\b)/i,
  /(?:^|\s)tee(?:\.exe)?\s+(?!-a?\s*$)/i,
  /\btask_registry\.py\b[\s\S]*\b(?:add-item|set|generate)\b/i,
  /\bappend_session_summary\.py\b[\s\S]*\bappend\b/i,
] as const;

function hasUnquotedShellRedirection(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if ((character === '\\' || character === '`') && index + 1 < command.length) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if ((character === '\\' || character === '`' || character === '^') && index + 1 < command.length) {
      index += 1;
      continue;
    }
    if (character === '>' && command[index + 1] !== '&' && command[index + 1] !== '|') return true;
  }
  return false;
}

function isSuccessfulCommand(item: UnknownRecord, source: UnknownRecord): boolean {
  if (toText(item.type ?? source.type) !== 'commandExecution' || !isAppliedItem(item, source)) return false;
  const exitCode = source.exitCode ?? item.exitCode;
  return exitCode === undefined || exitCode === null || exitCode === 0;
}

function getCommandTexts(item: UnknownRecord, source: UnknownRecord): string[] {
  const values: string[] = [];
  const command = source.command ?? item.command;
  if (typeof command === 'string') values.push(command);
  const actions = source.commandActions ?? item.commandActions;
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (isRecord(action) && typeof action.command === 'string') values.push(action.command);
    }
  }
  return values;
}

function isHighConfidenceWriteCommand(item: UnknownRecord, source: UnknownRecord): boolean {
  return isSuccessfulCommand(item, source)
    && getCommandTexts(item, source).some((command) => (
      HIGH_CONFIDENCE_WRITE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
      || hasUnquotedShellRedirection(command)
    ));
}

export function hasIncompleteChangedFilesReport(items: unknown[], projectRoot?: string): boolean {
  let unreportedWrite = false;
  for (const itemValue of items) {
    if (!isRecord(itemValue)) continue;
    const source = isRecord(itemValue.details)
      ? itemValue.details
      : isRecord(itemValue.raw)
        ? itemValue.raw
        : itemValue;
    if (isHighConfidenceWriteCommand(itemValue, source)) unreportedWrite = true;
    const storedRelayReport = isRecord(itemValue.details)
      && toText(itemValue.type) === 'dynamicToolCall'
      && normalizedStoredStatus(itemValue.status) === 'completed'
      && toText(source.tool) === RELAY_FILE_CHANGE_REPORT_TOOL
      ? parseRelayFileChangeReport(source.arguments)
      : null;
    const runtimeRelayReport = toText(itemValue.type) === 'dynamicToolCall'
      ? extractReportedFileChanges(itemValue)
      : [];
    const reportedChanges = runtimeRelayReport.length > 0
      ? runtimeRelayReport
      : storedRelayReport?.reportedFileChanges ?? [];
    const reportMatchesFinalState = reportedChanges.length > 0
      && (!projectRoot || reportedChanges.every((report) => {
        const normalizedPath = normalizeChangedPath(report.path, projectRoot);
        return normalizedPath !== null && isValidReportedOperation(projectRoot, {
          path: normalizedPath,
          changeType: report.changeType,
        });
      }));
    if (reportMatchesFinalState) unreportedWrite = false;
  }
  return unreportedWrite;
}

function normalizedStoredStatus(value: unknown): string {
  return toText(value).replace(/[_-]/g, '').toLowerCase();
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readFinalFileSize(
  projectRoot: string | undefined,
  filePath: string,
  changeType: ChangedFileType,
  external = false,
): number | undefined {
  if (changeType === 'deleted') return undefined;
  try {
    if (external) {
      if (!isAbsolutePath(filePath)) return undefined;
      const candidate = path.resolve(filePath);
      const linkStat = fs.lstatSync(candidate);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) return undefined;
      const size = fs.statSync(fs.realpathSync(candidate)).size;
      return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
    }
    if (!projectRoot) return undefined;
    const realRoot = fs.realpathSync(projectRoot);
    const candidate = path.resolve(realRoot, filePath);
    if (!isPathInsideRoot(candidate, realRoot)) return undefined;
    const linkStat = fs.lstatSync(candidate);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return undefined;
    const realFile = fs.realpathSync(candidate);
    if (!isPathInsideRoot(realFile, realRoot)) return undefined;
    const size = fs.statSync(realFile).size;
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

function isMissingReportedPath(projectRoot: string, filePath: string): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(projectRoot);
  } catch {
    return false;
  }

  const candidate = path.resolve(realRoot, filePath);
  if (!isPathInsideRoot(candidate, realRoot) || candidate === realRoot) return false;
  try {
    fs.lstatSync(candidate);
    return false;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') return false;
  }

  let ancestor = path.dirname(candidate);
  while (isPathInsideRoot(ancestor, realRoot)) {
    let ancestorLinkStat: fs.Stats;
    try {
      ancestorLinkStat = fs.lstatSync(ancestor);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return false;
      if (ancestor === realRoot) return false;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
      continue;
    }
    try {
      const realAncestor = fs.realpathSync(ancestor);
      if (!isPathInsideRoot(realAncestor, realRoot)) return false;
      return ancestorLinkStat.isSymbolicLink()
        ? fs.statSync(realAncestor).isDirectory()
        : ancestorLinkStat.isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

function isValidReportedOperation(
  projectRoot: string | undefined,
  operation: FileOperation,
): boolean {
  if (!projectRoot) return false;
  try {
    fs.realpathSync(projectRoot);
  } catch {
    return false;
  }
  if (operation.changeType === 'deleted') {
    return isMissingReportedPath(projectRoot, operation.path);
  }
  return readFinalFileSize(projectRoot, operation.path, operation.changeType) !== undefined;
}

export function collectChangedFiles(items: unknown[], projectRoot?: string): ChangedFile[] {
  const states = new Map<string, FileOperation>();
  for (const itemValue of items) {
    if (!isRecord(itemValue)) continue;
    const source = isRecord(itemValue.details)
      ? itemValue.details
      : isRecord(itemValue.raw)
        ? itemValue.raw
        : itemValue;
    const type = toText(itemValue.type ?? source.type);
    if (!isAppliedItem(itemValue, source)) continue;
    const operations = [
      ...type === 'fileChange'
        ? extractFileChange(itemValue, source, projectRoot)
        : extractApplyPatch(itemValue, source, projectRoot),
      ...extractEditToolPaths(itemValue, source, projectRoot),
    ];
    for (const report of extractReportedFileChanges(itemValue)) {
      const normalizedPath = normalizeChangedPath(report.path, projectRoot);
      if (!normalizedPath) continue;
      const operation: FileOperation = { path: normalizedPath, changeType: report.changeType };
      if (isValidReportedOperation(projectRoot, operation)) operations.push(operation);
    }
    for (const operation of operations) {
      const stateKey = `${operation.external ? 'external' : 'project'}:${operation.path}`;
      const current = states.get(stateKey);
      const merged = mergeOperation(current?.changeType, operation.changeType);
      if (merged) states.set(stateKey, { ...operation, changeType: merged });
      else states.delete(stateKey);
    }
  }
  return [...states.values()].slice(0, MAX_CHANGED_FILES).map((operation) => {
    const size = readFinalFileSize(projectRoot, operation.path, operation.changeType, operation.external);
    return {
      path: operation.path,
      changeType: operation.changeType,
      ...(size === undefined ? {} : { size }),
      ...(operation.external ? { external: true as const } : {}),
    };
  });
}
