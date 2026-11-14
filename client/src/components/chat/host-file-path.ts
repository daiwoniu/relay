export function getHostParentPath(filePath: string): string | null {
  if (!filePath) return null;
  const normalized = filePath.replace(/[\\/]+$/, '');
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) return '';
  const separatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (separatorIndex < 0) return '';
  if (separatorIndex === 0) return '/';
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}\\`;
  return normalized.slice(0, separatorIndex);
}
