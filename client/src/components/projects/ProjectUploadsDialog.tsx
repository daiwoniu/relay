import FailureNotice from '../ui/FailureNotice';
import { useEffect, useMemo, useState } from 'react';
import type { ProjectDto, ProjectUploadsResponseDto } from '../../generated/relay-contracts';
import {
  clearProjectUploads,
  deleteSelectedProjectUploads,
  listProjectUploads,
} from '../../api/project-uploads';
import DetailsDialog from '../layout/DetailsDialog';
import ConfirmDialog from '../ui/ConfirmDialog';
import FileTypeIcon from '../messages/FileTypeIcon';
import { getProjectUploadCleanupStats } from './project-upload-cleanup';

const MAX_SELECTED_UPLOADS = 10;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function ProjectUploadsDialog({ project, onClose }: { project: ProjectDto | null; onClose: () => void }) {
  const [data, setData] = useState<ProjectUploadsResponseDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<'selected' | 'all' | null>(null);

  useEffect(() => {
    if (!project) { setData(null); setSelected(new Set()); return; }
    let cancelled = false;
    setError('');
    void listProjectUploads(project.id).then((value) => { if (!cancelled) setData(value); }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '读取上传文件失败');
    });
    return () => { cancelled = true; };
  }, [project]);

  const allCleanupStats = useMemo(() => getProjectUploadCleanupStats(data?.files || []), [data]);
  const selectedCleanupStats = useMemo(() => getProjectUploadCleanupStats(data?.files || [], selected), [data, selected]);
  const usagePercent = data ? Math.min(100, (data.usage.usedBytes / data.usage.limitBytes) * 100) : 0;
  const cleanupBlocked = data?.cleanupBlockedReason || '';

  const deleteConfirmed = async () => {
    if (!project || !data || !confirm) return;
    try {
      const ids = [...selected];
      const response = confirm === 'all'
        ? await clearProjectUploads(project.id)
        : await deleteSelectedProjectUploads(project.id, ids);
      setData({
        ...data,
        usage: response.usage,
        files: confirm === 'all' ? [] : data.files.filter((file) => !selected.has(file.id)),
      });
      setSelected(new Set());
      setConfirm(null);
      setError('');
    } catch (reason) {
      setConfirm(null);
      setError(reason instanceof Error ? reason.message : '清理上传文件失败');
    }
  };

  return <>
    <DetailsDialog open={Boolean(project)} onClose={onClose} title="项目上传文件" description={project?.name} presentation="task" panelId={`project-uploads-dialog:${project?.id}`}>
      {!data && !error && <div className="py-8 text-center text-sm text-[var(--color-text-tertiary)]">正在读取…</div>}
      {error && <div role="alert" className="mb-3 rounded-lg bg-[var(--color-danger-surface)]/15 px-3 py-2 text-xs text-[var(--color-danger-text)]"><FailureNotice error={error} /></div>}
      {data && <div className="space-y-3">
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
          <div className="flex items-center justify-between text-xs"><span className="text-[var(--color-text-secondary)]">已用空间</span><span className="font-medium text-[var(--color-text)]">{formatBytes(data.usage.usedBytes)} / {formatBytes(data.usage.limitBytes)}</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]"><div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${usagePercent}%` }} /></div>
          <div className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">{data.files.length} 个已归档文件{data.usage.temporaryFileCount ? ` · ${data.usage.temporaryFileCount} 个待发送草稿` : ''}</div>
        </div>
        {cleanupBlocked && <div className="rounded-lg border border-[var(--color-status-warning)]/30 bg-[var(--color-status-warning)]/10 px-3 py-2 text-xs text-[var(--color-text-secondary)]">{cleanupBlocked}</div>}
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {data.files.length === 0 ? <div className="py-8 text-center text-sm text-[var(--color-text-tertiary)]">没有已归档的上传文件</div> : data.files.map((file) => (
            <label key={file.id} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-surface-hover)]">
              <input type="checkbox" checked={selected.has(file.id)} disabled={Boolean(cleanupBlocked) || (!selected.has(file.id) && selected.size >= MAX_SELECTED_UPLOADS)} onChange={(event) => setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(file.id); else next.delete(file.id);
                return next;
              })} />
              <FileTypeIcon filePath={file.name} size={16} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-[var(--color-text)]">{file.name}</span><span className="text-[11px] text-[var(--color-text-tertiary)]">{formatBytes(file.size)} · {file.mimeType}</span></span>
              {!file.available && <span className="text-[11px] text-[var(--color-text-tertiary)]">已清理</span>}
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
          <span className="text-[11px] text-[var(--color-text-tertiary)]">已选 {selected.size}/{MAX_SELECTED_UPLOADS} 个 · 可释放约 {formatBytes(selectedCleanupStats.releasableBytes)}{selectedCleanupStats.unavailableCount > 0 ? ` · ${selectedCleanupStats.unavailableCount} 个已清理` : ''}</span>
          <div className="flex gap-2">
            <button type="button" disabled={Boolean(cleanupBlocked) || selected.size === 0} onClick={() => setConfirm('selected')} className="rounded-lg px-3 py-1.5 text-xs text-[var(--color-danger-text)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40">删除选中</button>
            <button type="button" disabled={Boolean(cleanupBlocked) || data.files.length === 0} onClick={() => setConfirm('all')} className="rounded-lg bg-[var(--color-danger-surface)] px-3 py-1.5 text-xs text-white disabled:opacity-40">全部清理</button>
          </div>
        </div>
      </div>}
    </DetailsDialog>
    <ConfirmDialog
      open={confirm !== null}
      title={confirm === 'all' ? '清理全部上传文件' : '删除选中的上传文件'}
      tone="danger"
      description={confirm === 'all' ? '请确认要清理的项目及全部上传内容。' : '请确认要删除的已选上传文件。'}
      subject={project ? {
        label: '所属项目',
        value: project.name,
        detail: confirm === 'all'
          ? `${allCleanupStats.recordCount} 个上传记录 · 可释放约 ${formatBytes(allCleanupStats.releasableBytes)}`
          : `${selectedCleanupStats.recordCount} 个上传记录 · 可释放约 ${formatBytes(selectedCleanupStats.releasableBytes)}`,
      } : undefined}
      impacts={confirm === 'all'
        ? [
            <><strong>{allCleanupStats.recordCount} 个上传记录</strong>将被清理</>,
            allCleanupStats.releasableBytes > 0
              ? <><strong>约 {formatBytes(allCleanupStats.releasableBytes)}</strong>可用文件占用将被释放</>
              : '对应文件均已清理，不会释放额外磁盘空间',
            ...(allCleanupStats.unavailableCount > 0 ? [`其中 ${allCleanupStats.unavailableCount} 个记录对应文件已清理，仅移除归档记录`] : []),
          ]
        : [
            <><strong>{selectedCleanupStats.recordCount} 个上传记录</strong>将被清理</>,
            selectedCleanupStats.releasableBytes > 0
              ? <><strong>约 {formatBytes(selectedCleanupStats.releasableBytes)}</strong>可用文件占用将被释放</>
              : '选中记录对应文件均已清理，不会释放额外磁盘空间',
            ...(selectedCleanupStats.unavailableCount > 0 ? [`其中 ${selectedCleanupStats.unavailableCount} 个记录对应文件已清理，仅移除归档记录`] : []),
          ]}
      notice={{
        tone: 'info',
        title: '历史消息仍会保留附件摘要',
        description: '文件名称和大小仍会显示，但附件会标记为“文件已清理”，无法再下载或预览。实际释放空间以清理完成后的统计为准。',
      }}
      confirmLabel={confirm === 'all' ? '全部清理' : '删除'}
      onCancel={() => setConfirm(null)}
      onConfirm={deleteConfirmed}
    />
  </>;
}
