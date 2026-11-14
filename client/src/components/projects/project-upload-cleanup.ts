export interface ProjectUploadCleanupFile {
  id: string;
  size: number;
  available: boolean;
}

export interface ProjectUploadCleanupStats {
  recordCount: number;
  availableCount: number;
  unavailableCount: number;
  releasableBytes: number;
}

export function getProjectUploadCleanupStats(
  files: ProjectUploadCleanupFile[],
  selectedIds?: ReadonlySet<string>,
): ProjectUploadCleanupStats {
  const scopedFiles = selectedIds
    ? files.filter((file) => selectedIds.has(file.id))
    : files;
  const availableFiles = scopedFiles.filter((file) => file.available);
  return {
    recordCount: scopedFiles.length,
    availableCount: availableFiles.length,
    unavailableCount: scopedFiles.length - availableFiles.length,
    releasableBytes: availableFiles.reduce((sum, file) => sum + file.size, 0),
  };
}
