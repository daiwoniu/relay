import type { ProcessItemDto } from '../contracts/index.js';
import { presentProcessItems } from './presenter.js';

const COMMAND_FIELD_LIMIT = 8 * 1024;
const NARRATIVE_FIELD_LIMIT = 16 * 1024;
const SUMMARY_LINE_LIMIT = 320;

const OUTPUT_ITEM_TYPES = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall']);
const UNBOUNDED_ITEM_TYPES = new Set(['interaction', 'systemNotice']);
const COMMAND_FIELDS = ['command', 'diff', 'patch', 'arguments', 'input', 'params'] as const;
const NARRATIVE_FIELDS = ['reasoning', 'prompt', 'content', 'text', 'explanation'] as const;
const OUTPUT_FIELDS = ['aggregatedOutput', 'result', 'output'] as const;
const FILE_CHANGE_FIELDS = ['changes', 'files', 'fileChanges'] as const;
const FILE_CHANGE_DETAIL_KEYS = new Set([
  'path', 'filePath', 'file', 'changeType', 'action', 'kind', 'cwd',
  'changes', 'files', 'fileChanges',
  'exitCode', 'errorCode', 'failureCode', 'durationMs', 'duration',
  'firstObservedAt', 'startedObservedAt', 'completedObservedAt',
]);

type OutputSource = typeof OUTPUT_FIELDS[number];

export interface StoredOutputSummary extends Record<string, unknown> {
  source: OutputSource;
  lineCount: number;
  charCount: number;
  firstLine: string;
  lastLine: string;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripTerminalControlCodes(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function stringifyDisplayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateHeadAndTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let omitted = text.length - maxLength;
  let marker = `\n…[Relay 已省略 ${omitted} 个字符]…\n`;
  let available = Math.max(2, maxLength - marker.length);
  let headLength = Math.ceil(available / 2);
  let tailLength = Math.floor(available / 2);
  omitted = text.length - headLength - tailLength;
  marker = `\n…[Relay 已省略 ${omitted} 个字符]…\n`;
  available = Math.max(2, maxLength - marker.length);
  headLength = Math.ceil(available / 2);
  tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}

function boundField(value: unknown, maxLength: number): unknown {
  const text = stringifyDisplayValue(value);
  return text.length > maxLength ? truncateHeadAndTail(text, maxLength) : value;
}

function summarizeOutput(source: OutputSource, value: unknown): StoredOutputSummary | undefined {
  const text = stripTerminalControlCodes(stringifyDisplayValue(value)).trim();
  if (!text) return undefined;
  const lines = text.split('\n');
  const firstLine = lines.find((line) => line.trim())?.trim() ?? '';
  const lastLine = [...lines].reverse().find((line) => line.trim())?.trim() ?? firstLine;
  const boundedFirstLine = truncateHeadAndTail(firstLine, SUMMARY_LINE_LIMIT);
  const boundedLastLine = truncateHeadAndTail(lastLine, SUMMARY_LINE_LIMIT);
  const representedCompletely = lines.length <= 2
    && boundedFirstLine === firstLine
    && boundedLastLine === lastLine;
  return {
    source,
    lineCount: lines.length,
    charCount: text.length,
    firstLine: boundedFirstLine,
    lastLine: boundedLastLine,
    truncated: !representedCompletely,
  };
}

function normalizeStoredOutputSummary(value: unknown): StoredOutputSummary | undefined {
  if (!isRecord(value) || !OUTPUT_FIELDS.includes(value.source as OutputSource)) return undefined;
  const lineCount = Number(value.lineCount);
  const charCount = Number(value.charCount);
  if (!Number.isInteger(lineCount) || lineCount < 1 || !Number.isInteger(charCount) || charCount < 0) return undefined;
  const firstLine = typeof value.firstLine === 'string'
    ? truncateHeadAndTail(stripTerminalControlCodes(value.firstLine).trim(), SUMMARY_LINE_LIMIT)
    : '';
  const lastLine = typeof value.lastLine === 'string'
    ? truncateHeadAndTail(stripTerminalControlCodes(value.lastLine).trim(), SUMMARY_LINE_LIMIT)
    : firstLine;
  return {
    source: value.source as OutputSource,
    lineCount,
    charCount,
    firstLine,
    lastLine,
    truncated: value.truncated === true,
  };
}

function compactFileChanges(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [{ path: entry }];
    if (!isRecord(entry)) return [];
    const changeType = typeof entry.changeType === 'string'
      ? entry.changeType
      : typeof entry.type === 'string'
        ? entry.type
        : typeof entry.action === 'string'
          ? entry.action
          : undefined;
    const compact = {
      ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
      ...(typeof entry.filePath === 'string' ? { filePath: entry.filePath } : {}),
      ...(typeof entry.file === 'string' ? { file: entry.file } : {}),
      ...(changeType ? { changeType } : {}),
    };
    return Object.keys(compact).length > 0 ? [compact] : [];
  });
}

function compactDetails(item: ProcessItemDto): Record<string, unknown> {
  const details = { ...item.details };
  for (const key of FILE_CHANGE_FIELDS) {
    if (details[key] !== undefined) details[key] = compactFileChanges(details[key]);
  }
  if (item.type === 'fileChange') {
    return Object.fromEntries(Object.entries(details).filter(([key]) => FILE_CHANGE_DETAIL_KEYS.has(key)));
  }
  if (UNBOUNDED_ITEM_TYPES.has(item.type) || details.interactionKind !== undefined) return details;

  if (Array.isArray(details.plan)) {
    details.plan = details.plan.map((entry) => ({
      step: boundField(entry.step, NARRATIVE_FIELD_LIMIT), status: entry.status,
    }));
  }

  if (Array.isArray(details.commandActions)) {
    details.commandActions = details.commandActions.flatMap((action) => {
      if (!isRecord(action) || typeof action.command !== 'string') return [];
      return [{ command: boundField(action.command, COMMAND_FIELD_LIMIT) }];
    });
  }

  for (const key of COMMAND_FIELDS) {
    if (details[key] !== undefined) details[key] = boundField(details[key], COMMAND_FIELD_LIMIT);
  }
  for (const key of NARRATIVE_FIELDS) {
    if (details[key] !== undefined) details[key] = boundField(details[key], NARRATIVE_FIELD_LIMIT);
  }
  if (OUTPUT_ITEM_TYPES.has(item.type)) {
    let outputSummary = normalizeStoredOutputSummary(details.outputSummary);
    delete details.outputSummary;
    for (const source of OUTPUT_FIELDS) {
      if (!outputSummary && details[source] !== undefined) outputSummary = summarizeOutput(source, details[source]);
      delete details[source];
    }
    if (outputSummary) details.outputSummary = outputSummary;
  }
  return details;
}

export function compactProcessItemsForStorage(items: unknown[]): ProcessItemDto[] {
  return presentProcessItems(items).map((item) => ({ ...item, details: compactDetails(item) }));
}

export function compactMessageItemsJsonForStorage(items: string | null): {
  value: string | null;
  changed: boolean;
  beforeBytes: number;
  afterBytes: number;
} {
  const beforeBytes = items === null ? 0 : Buffer.byteLength(items);
  if (!items) return { value: items, changed: false, beforeBytes, afterBytes: beforeBytes };
  try {
    const parsed = JSON.parse(items);
    if (!Array.isArray(parsed)) return { value: items, changed: false, beforeBytes, afterBytes: beforeBytes };
    const value = JSON.stringify(compactProcessItemsForStorage(parsed));
    return {
      value,
      changed: value !== items,
      beforeBytes,
      afterBytes: Buffer.byteLength(value),
    };
  } catch {
    return { value: items, changed: false, beforeBytes, afterBytes: beforeBytes };
  }
}
