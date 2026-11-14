type FileTransferSource = Pick<DataTransfer, 'files' | 'items'>;

export function extractTransferredFiles(source: FileTransferSource): File[] {
  const fileItems = Array.from(source.items || []).filter((item) => item.kind === 'file');
  if (fileItems.length > 0) return fileItems.flatMap((item) => {
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isFile: boolean } | null;
    }).webkitGetAsEntry?.();
    if (entry && !entry.isFile) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });

  return Array.from(source.files || []);
}

export function hasTransferredFiles(source: Pick<DataTransfer, 'types' | 'items'>): boolean {
  return Array.from(source.types || []).includes('Files')
    || Array.from(source.items || []).some((item) => item.kind === 'file');
}
