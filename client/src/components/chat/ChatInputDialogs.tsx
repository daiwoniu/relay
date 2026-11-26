import type { ReactNode } from 'react';
import type { Project } from '../../stores/chat';
import DetailsDialog from '../layout/DetailsDialog';
import ProjectDetailsContent from '../layout/ProjectDetailsContent';
import ConfirmDialog from '../ui/ConfirmDialog';
import DirectoryPicker from './DirectoryPicker';
import HostFilePicker from './HostFilePicker';
import type { ChatInputMobileDetails } from './ChatInputMetadataBar';
import type { HostFileDraft } from './host-file-drafts';

interface Props {
  mobileDetails: ChatInputMobileDetails | null;
  onCloseMobileDetails: () => void;
  currentProject?: Project;
  contextUsageDetails: ReactNode;
  clearConfirmOpen: boolean;
  onCancelClear: () => void;
  onConfirmClear: () => void;
  showDirPicker: boolean;
  initialDirectoryPath?: string;
  onSelectDirectory: (path: string) => void;
  onCancelDirectoryPicker: () => void;
  showHostFilePicker: boolean;
  initialHostFilePath?: string;
  remainingHostFileSlots: number;
  existingHostFilePaths: string[];
  onHostFileDirectoryChange: (path: string) => void;
  onAddHostFiles: (files: HostFileDraft[]) => void;
  onCancelHostFilePicker: () => void;
}

export default function ChatInputDialogs({ mobileDetails, onCloseMobileDetails, currentProject, contextUsageDetails, clearConfirmOpen, onCancelClear, onConfirmClear, showDirPicker, initialDirectoryPath, onSelectDirectory, onCancelDirectoryPicker, showHostFilePicker, initialHostFilePath, remainingHostFileSlots, existingHostFilePaths, onHostFileDirectoryChange, onAddHostFiles, onCancelHostFilePicker }: Props) {
  return (
    <>
      <DetailsDialog open={mobileDetails !== null} onClose={onCloseMobileDetails} title={mobileDetails === 'project' ? '项目详情' : '上下文用量'}>
        {mobileDetails === 'project' && (currentProject ? <ProjectDetailsContent project={currentProject} /> : null)}
        {mobileDetails === 'context' && contextUsageDetails}
      </DetailsDialog>

      <ConfirmDialog open={clearConfirmOpen} title="清空输入内容？" tone="warning" description="当前输入的文字将被清空。" cancelLabel="继续编辑" confirmLabel="清空文字" onCancel={onCancelClear} onConfirm={onConfirmClear} />

      {showDirPicker && <DirectoryPicker initialPath={initialDirectoryPath} onSelect={onSelectDirectory} onCancel={onCancelDirectoryPicker} />}
      {showHostFilePicker && <HostFilePicker initialPath={initialHostFilePath} remainingSlots={remainingHostFileSlots} existingHostFilePaths={existingHostFilePaths} onDirectoryChange={onHostFileDirectoryChange} onSelect={onAddHostFiles} onCancel={onCancelHostFilePicker} />}
    </>
  );
}
