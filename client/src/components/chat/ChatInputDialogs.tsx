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
  stopConfirmOpen: boolean;
  isAwaitingAction: boolean;
  onCancelStop: () => void;
  onConfirmStop: () => void;
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

export default function ChatInputDialogs({ mobileDetails, onCloseMobileDetails, currentProject, contextUsageDetails, stopConfirmOpen, isAwaitingAction, onCancelStop, onConfirmStop, clearConfirmOpen, onCancelClear, onConfirmClear, showDirPicker, initialDirectoryPath, onSelectDirectory, onCancelDirectoryPicker, showHostFilePicker, initialHostFilePath, remainingHostFileSlots, existingHostFilePaths, onHostFileDirectoryChange, onAddHostFiles, onCancelHostFilePicker }: Props) {
  return (
    <>
      <DetailsDialog open={mobileDetails !== null} onClose={onCloseMobileDetails} title={mobileDetails === 'project' ? '项目详情' : '上下文用量'}>
        {mobileDetails === 'project' && (currentProject ? <ProjectDetailsContent project={currentProject} /> : null)}
        {mobileDetails === 'context' && contextUsageDetails}
      </DetailsDialog>

      <ConfirmDialog open={stopConfirmOpen} title={isAwaitingAction ? '停止等待？' : '停止生成？'} tone="warning" description={isAwaitingAction ? '确定不再等待当前操作吗？' : '确定停止继续生成这条回复吗？'} impacts={[isAwaitingAction ? '当前等待中的操作将不再继续' : '当前回复将停止继续生成']} notice={{ tone: 'info', title: '已有内容不会丢失', description: '已经生成的内容会保留。' }} confirmLabel={isAwaitingAction ? '停止等待' : '停止生成'} onCancel={onCancelStop} onConfirm={onConfirmStop} />

      <ConfirmDialog open={clearConfirmOpen} title="清空输入内容？" tone="warning" description="当前输入的文字将被清空。" cancelLabel="继续编辑" confirmLabel="清空文字" onCancel={onCancelClear} onConfirm={onConfirmClear} />

      {showDirPicker && <DirectoryPicker initialPath={initialDirectoryPath} onSelect={onSelectDirectory} onCancel={onCancelDirectoryPicker} />}
      {showHostFilePicker && <HostFilePicker initialPath={initialHostFilePath} remainingSlots={remainingHostFileSlots} existingHostFilePaths={existingHostFilePaths} onDirectoryChange={onHostFileDirectoryChange} onSelect={onAddHostFiles} onCancel={onCancelHostFilePicker} />}
    </>
  );
}
