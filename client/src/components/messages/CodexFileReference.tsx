import type { KeyboardEvent, MouseEvent } from 'react';
import Tooltip from '../ui/Tooltip';
import FileTypeIcon from './FileTypeIcon';
import { useFilePreview } from './useFilePreview';
import { resolveCodexFileReferencePathResult, type CodexFileReferenceData } from './codex-file-directives';
import { hasExpandedSelectionWithin } from './markdown-selection';

interface Props {
  reference: CodexFileReferenceData;
  projectPath?: string;
  readOnly?: boolean;
}

const KIND_LABELS: Record<CodexFileReferenceData['kind'], string> = {
  file: '文件',
  visualization: '可视化',
  template: '模板',
};

export default function CodexFileReference({ reference, projectPath, readOnly = false }: Props) {
  const openFilePreview = useFilePreview();
  const displayLabel = reference.locator
    ? `${reference.label} · ${reference.locator}`
    : reference.kind === 'template'
      ? `模板：${reference.label}`
      : reference.label;
  const accessibleLabel = `预览${KIND_LABELS[reference.kind]}：${reference.path}`;
  const resolution = resolveCodexFileReferencePathResult(reference.path, projectPath);

  const openPreview = () => {
    if (!resolution.ok) return;
    void openFilePreview(resolution.path, {
      preferredMode: reference.preferredMode,
      allowHtmlScripts: reference.kind === 'visualization',
    });
  };
  const handleClick = (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (hasExpandedSelectionWithin(event.currentTarget)) return;
    openPreview();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openPreview();
  };

  if (readOnly) return <span className="md-link-file cursor-default">{displayLabel}</span>;
  if (!resolution.ok) {
    return (
      <Tooltip content={resolution.reason} inline>
        <span
          className="md-link-file cursor-not-allowed opacity-60"
          data-codex-file-kind={reference.kind}
          aria-disabled="true"
          aria-label={`${displayLabel}：${resolution.reason}`}
        >
          <FileTypeIcon filePath={reference.path} className="inline-block mr-0.5 -mt-0.5 shrink-0 opacity-70" />
          {displayLabel}
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={accessibleLabel} inline>
      <span
        className="md-link-file"
        data-codex-file-kind={reference.kind}
        role="button"
        tabIndex={0}
        aria-label={accessibleLabel}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <FileTypeIcon filePath={reference.path} className="inline-block mr-0.5 -mt-0.5 shrink-0 opacity-70" />
        {displayLabel}
      </span>
    </Tooltip>
  );
}
