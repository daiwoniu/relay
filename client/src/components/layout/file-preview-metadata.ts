import { getFileIconType } from '../messages/file-icon-type.ts';
import { formatDateTime } from '../../utils/date-display.ts';

const EXACT_TYPE_LABELS: Record<string, string> = {
  md: 'Markdown 文档', markdown: 'Markdown 文档', mdx: 'MDX 文档',
  pdf: 'PDF 文档', doc: 'Word 文档', docx: 'Word 文档', rtf: 'RTF 文档',
  xls: 'Excel 工作簿', xlsx: 'Excel 工作簿', csv: 'CSV 表格', tsv: 'TSV 表格',
  ts: 'TypeScript 源代码', tsx: 'TypeScript React 源代码', js: 'JavaScript 源代码', jsx: 'JavaScript React 源代码',
  json: 'JSON 配置文件', yaml: 'YAML 配置文件', yml: 'YAML 配置文件', toml: 'TOML 配置文件',
  png: 'PNG 图片', jpg: 'JPEG 图片', jpeg: 'JPEG 图片', gif: 'GIF 图片', webp: 'WebP 图片', svg: 'SVG 图片',
  txt: '文本文件', html: 'HTML 文档', css: 'CSS 样式表', sql: 'SQL 文件',
};

function getExtension(filePath: string): string {
  const normalized = filePath.trim().replace(/[?#].*$/, '').replace(/\\/g, '/');
  const fileName = normalized.split('/').filter(Boolean).pop() || '';
  if (!fileName.includes('.') || fileName.endsWith('.')) return '';
  return fileName.split('.').pop()?.toLowerCase() || '';
}

export function getFileMetadataTypeLabel(filePath: string): string {
  const extension = getExtension(filePath);
  if (extension && EXACT_TYPE_LABELS[extension]) return EXACT_TYPE_LABELS[extension];
  if (!extension) return '无扩展名文件';
  const prefix = extension.toUpperCase();
  const category = getFileIconType(filePath);
  if (category === 'image') return `${prefix} 图片`;
  if (category === 'code') return `${prefix} 源代码`;
  if (category === 'archive') return `${prefix} 压缩文件`;
  if (category === 'audio') return `${prefix} 音频`;
  if (category === 'video') return `${prefix} 视频`;
  if (category === 'table') return `${prefix} 表格`;
  if (category === 'config') return `${prefix} 配置文件`;
  if (category === 'document') return `${prefix} 文档`;
  return `${prefix} 文件`;
}

export function formatFileMetadataSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 || Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

export function formatFileMetadataTime(timestamp: number | null | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '系统未提供';
  return formatDateTime(timestamp, { seconds: true, fallback: '系统未提供' });
}
