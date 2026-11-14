import type { ChangedFileDto, ChangedFileType, MessageOutcome } from '../../generated/relay-contracts';

export function getChangedFilesTitle(files: readonly Pick<ChangedFileDto, 'changeType'>[], outcome?: MessageOutcome): string {
  if (outcome && outcome !== 'completed') {
    return `处理期间变更了 ${files.length} 个文件`;
  }

  const changeTypes = new Set(files.map((file) => file.changeType));
  let action = '变更';
  if (changeTypes.size === 1) {
    if (changeTypes.has('added')) action = '新增';
    if (changeTypes.has('modified')) action = '修改';
    if (changeTypes.has('deleted')) action = '删除';
  }
  return `此次${action}了 ${files.length} 个文件`;
}

export function splitChangedFilePath(filePath: string): { name: string; directory: string } {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);
  return {
    name: parts.pop() || normalized,
    directory: parts.join('/'),
  };
}

export function resolveProjectFilePath(projectPath: string, filePath: string): string {
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  if (/^(?:[A-Za-z]:|\/)/.test(normalizedFilePath) || normalizedFilePath.split('/').includes('..')) {
    throw new Error('文件路径不在当前项目内');
  }
  const root = projectPath.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:[\\/]/.test(root) || root.includes('\\')) {
    return `${root}\\${normalizedFilePath.replace(/\//g, '\\')}`;
  }
  return `${root}/${normalizedFilePath}`;
}

export function resolveChangedFilePreviewPath(
  file: Pick<ChangedFileDto, 'path' | 'external'>,
  projectPath?: string,
): string {
  if (file.external) {
    const normalized = file.path.replace(/\\/g, '/');
    if (!/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$)|\/)/.test(normalized)
      || normalized.split('/').includes('..')
      || /[\u0000-\u001F\u007F]/.test(normalized)) {
      throw new Error('外部文件路径无效');
    }
    return file.path;
  }
  if (!projectPath) throw new Error('当前消息缺少项目路径');
  return resolveProjectFilePath(projectPath, file.path);
}

export function getChangedFilePresentation(changeType: ChangedFileType) {
  switch (changeType) {
    case 'added':
      return { marker: '+', label: '新增', tone: 'added' as const };
    case 'deleted':
      return { marker: '−', label: '已删除', tone: 'deleted' as const };
    default:
      return { marker: 'M', label: '修改', tone: 'modified' as const };
  }
}

export function formatChangedFileSize(size: number | undefined): string {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
