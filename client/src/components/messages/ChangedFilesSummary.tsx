import { useId, useState } from 'react';
import type { ChangedFileDto, MessageOutcome } from '../../generated/relay-contracts';
import Tooltip from '../ui/Tooltip';
import {
  formatChangedFileSize,
  getChangedFilePresentation,
  getChangedFilesTitle,
  resolveChangedFilePreviewPath,
  splitChangedFilePath,
} from './changed-files-view';
import FileTypeIcon from './FileTypeIcon';
import ChangedFilesIncompleteNotice from './ChangedFilesIncompleteNotice';

interface Props {
  files: ChangedFileDto[];
  changedFilesIncomplete?: boolean;
  outcome?: MessageOutcome;
  projectPath?: string;
  mobile?: boolean;
  readOnly?: boolean;
  full?: boolean;
  onOpenFile: (filePath: string) => void;
}

export default function ChangedFilesSummary({ files, changedFilesIncomplete = false, outcome, projectPath, mobile = false, readOnly = false, full, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  if (files.length === 0) return null;

  const visibleFiles = full ? files : mobile && !showAll ? files.slice(0, 6) : files;
  const remaining = files.length - visibleFiles.length;
  const displayExpanded = full || expanded;

  return (
    <section className="changed-files-summary" aria-label="此次处理修改的文件">
      <button
        type="button"
        className="changed-files-summary__toggle"
        aria-expanded={displayExpanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="changed-files-summary__title">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" data-icon="file-stack" aria-hidden="true">
            <path d="M5 2.5h6.5a1 1 0 011 1V11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
            <rect x="2.5" y="4.5" width="8.5" height="9" rx="1" stroke="currentColor" strokeWidth="1.25" />
            <path d="M4.5 7.5h4.5M4.5 10h4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
          <span>{getChangedFilesTitle(files, outcome)}</span>
        </span>
        <svg className={`changed-files-summary__chevron ${displayExpanded ? 'is-expanded' : ''}`} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {changedFilesIncomplete && (
        <div className="px-3 py-2">
          <ChangedFilesIncompleteNotice />
        </div>
      )}

      {displayExpanded && (
        <div id={listId} className="changed-files-summary__content">
          <div className="changed-files-summary__list">
            {visibleFiles.map((file) => {
              const presentation = getChangedFilePresentation(file.changeType);
              const pathParts = splitChangedFilePath(file.path);
              const sizeLabel = formatChangedFileSize(file.size);
              const disabled = readOnly || file.changeType === 'deleted' || (!file.external && !projectPath);
              const previewLabel = file.external
                ? `点击申请单文件授权并预览：${file.path}`
                : `点击预览文件：${file.path}`;
              const row = (
                <button
                  key={file.path}
                  type="button"
                  className={`changed-file-row changed-file-row--${presentation.tone}`}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    onOpenFile(resolveChangedFilePreviewPath(file, projectPath));
                  }}
                  aria-label={disabled ? `${presentation.label}：${file.path}` : previewLabel}
                >
                  <span className="changed-file-row__marker" aria-hidden="true">{presentation.marker}</span>
                  <span className="changed-file-row__path">
                    <span className="changed-file-row__name inline-flex items-center gap-1">
                      <FileTypeIcon filePath={file.path} className="shrink-0 text-[var(--color-text-tertiary)]" />
                      <span className="min-w-0 overflow-hidden text-ellipsis">{pathParts.name}</span>
                    </span>
                    {pathParts.directory && <span className="changed-file-row__directory">{pathParts.directory}</span>}
                  </span>
                  {sizeLabel && <span className="changed-file-row__size">{sizeLabel}</span>}
                </button>
              );
              return disabled ? row : <Tooltip key={file.path} className="w-full" content={previewLabel}>{row}</Tooltip>;
            })}
          </div>
          {remaining > 0 && (
            <button type="button" className="changed-files-summary__more" onClick={() => setShowAll(true)}>
              当前显示 {visibleFiles.length} / {files.length} 个，查看其余 {remaining} 个文件
            </button>
          )}
        </div>
      )}
    </section>
  );
}
