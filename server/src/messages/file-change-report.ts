export type ReportedFileChangeType = 'added' | 'modified' | 'deleted';

export interface ReportedFileChange {
  path: string;
  changeType: ReportedFileChangeType;
}

export interface RelayFileChangeReport {
  version: 1;
  reportedFileChanges: ReportedFileChange[];
}

export const RELAY_FILE_CHANGE_REPORT_TOOL = 'relay_report_file_changes';
export const RELAY_FILE_CHANGE_REPORT_VERSION = 1;
export const MAX_REPORTED_FILE_CHANGES = 500;

export const RELAY_FILE_CHANGE_REPORT_TOOL_SPEC = {
  type: 'function',
  name: RELAY_FILE_CHANGE_REPORT_TOOL,
  description: '非 apply_patch 工具实际新增、修改、删除或移动文件后必须调用。仅在文件操作成功后调用；每次后续写入都必须重新报告，路径必须指向当前项目中的最终文件状态。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'reportedFileChanges'],
    properties: {
      version: { type: 'integer', const: RELAY_FILE_CHANGE_REPORT_VERSION },
      reportedFileChanges: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_REPORTED_FILE_CHANGES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'changeType'],
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 4096 },
            changeType: { type: 'string', enum: ['added', 'modified', 'deleted'] },
          },
        },
      },
    },
  },
} as const;

type UnknownRecord = Record<string, unknown>;

const REPORT_TYPES = new Set<ReportedFileChangeType>(['added', 'modified', 'deleted']);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedStatus(item: UnknownRecord): string {
  return toText(item.status).replace(/[_-]/g, '').toLowerCase();
}

export function parseRelayFileChangeReport(value: unknown): RelayFileChangeReport | null {
  if (!isRecord(value)
    || value.version !== RELAY_FILE_CHANGE_REPORT_VERSION
    || !Array.isArray(value.reportedFileChanges)
    || value.reportedFileChanges.length < 1
    || value.reportedFileChanges.length > MAX_REPORTED_FILE_CHANGES) return null;

  const reportedFileChanges: ReportedFileChange[] = [];
  for (const entry of value.reportedFileChanges) {
    if (!isRecord(entry)) return null;
    const filePath = toText(entry.path);
    const changeType = toText(entry.changeType) as ReportedFileChangeType;
    if (!filePath
      || filePath.length > 4096
      || /[\u0000-\u001F\u007F]/.test(filePath)
      || !REPORT_TYPES.has(changeType)) return null;
    reportedFileChanges.push({ path: filePath, changeType });
  }

  return { version: RELAY_FILE_CHANGE_REPORT_VERSION, reportedFileChanges };
}

function extractRelayDynamicToolReport(item: UnknownRecord): ReportedFileChange[] {
  if (item.type !== 'dynamicToolCall'
    || normalizedStatus(item) !== 'completed'
    || item.success !== true
    || item.namespace !== null
    || item.tool !== RELAY_FILE_CHANGE_REPORT_TOOL) return [];
  return parseRelayFileChangeReport(item.arguments)?.reportedFileChanges ?? [];
}

function extractImageGenerationReport(item: UnknownRecord): ReportedFileChange[] {
  if (item.type !== 'imageGeneration' || normalizedStatus(item) !== 'completed') return [];
  const savedPath = toText(item.savedPath);
  return savedPath ? [{ path: savedPath, changeType: 'added' }] : [];
}

export function extractReportedFileChanges(item: unknown): ReportedFileChange[] {
  if (!isRecord(item)) return [];
  return item.type === 'dynamicToolCall'
    ? extractRelayDynamicToolReport(item)
    : extractImageGenerationReport(item);
}
