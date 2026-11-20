import type { HostingInspection } from '../../generated/relay-contracts';

export const formatHostingSize = (bytes: number) => bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(1)} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function formatHostingInspectionSummary(stage: Pick<HostingInspection, 'fileCount' | 'totalBytes' | 'rewritten' | 'warningCount'>): string {
  return `共 ${stage.fileCount} 个文件 · ${formatHostingSize(stage.totalBytes)} · 已修正 ${stage.rewritten} 处路径${stage.warningCount > 0 ? ` · ${stage.warningCount} 项提示` : ''}`;
}
