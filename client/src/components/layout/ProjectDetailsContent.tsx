import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../stores/chat';
import { copyToClipboard } from '../../utils/clipboard';
import IconActionButton from '../ui/IconActionButton';
import MiddleEllipsisPath from '../ui/MiddleEllipsisPath';
import { getProject } from '../../api/projects';
import { formatResourcePerson } from '../../utils/resource-person';

export default function ProjectDetailsContent({ project }: { project: Project }) {
  const [summary, setSummary] = useState<{ id: string; count?: number; shared?: boolean; failed?: boolean } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    void getProject(project.id, controller.signal).then((details) => {
      if (!controller.signal.aborted) setSummary({ id: project.id, count: details.session_count,
        shared: !!details.access_role && details.access_role !== 'owner' });
    }).catch(() => {
      if (!controller.signal.aborted) setSummary({ id: project.id, failed: true });
    });
    return () => controller.abort();
  }, [project.id]);

  const currentSummary = summary?.id === project.id ? summary : null;
  const sessionCount = !currentSummary ? '正在读取…' : currentSummary.failed ? '读取失败' : currentSummary.count ?? '—';

  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);

  const handleCopy = async () => {
    try {
      await copyToClipboard(project.path);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => {
      feedbackTimer.current = null;
      setCopyState('idle');
    }, 2000);
  };

  return (
    <div className="space-y-1.5 text-xs">
      <div className="break-words font-medium text-[var(--color-text)]">{project.name}</div>
      <div className="text-[var(--color-text-secondary)]">会话数：{sessionCount}</div>
      {currentSummary?.shared && <div className="text-[11px] text-[var(--color-text-tertiary)]">仅统计你有权限查看的会话</div>}
      <div className="break-words text-[var(--color-text-secondary)]">创建人：{formatResourcePerson(project.owner)}</div>
      {project.deletion_protected ? <div className="text-[var(--color-danger-text)]">删除保护：已开启</div> : null}
      <div className="select-all break-all border-t border-[var(--color-border-light)] pt-1.5 text-[11px] text-[var(--color-text-tertiary)]">项目 ID：{project.id}</div>
      <div className="flex min-w-0 items-center gap-1">
        {copyState === 'failed' ? (
          <div className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-danger-text)]">复制失败，请重试</div>
        ) : (
          <MiddleEllipsisPath
            path={project.path}
            className="min-w-0 flex-1 text-[11px] text-[var(--color-text-secondary)]"
          />
        )}
        <IconActionButton
          label={copyState === 'copied' ? '已复制完整路径' : copyState === 'failed' ? '重新复制完整路径' : '复制完整项目路径'}
          variant="neutral"
          tooltip={false}
          className={`h-6 w-6 rounded-md ${copyState === 'copied' ? 'text-[var(--color-status-success)]' : ''}`}
          onClick={() => void handleCopy()}
        >
          {copyState === 'copied' ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M3 10H2.5A1.5 1.5 0 011 8.5v-6A1.5 1.5 0 012.5 1h6A1.5 1.5 0 0110 2.5V3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          )}
        </IconActionButton>
      </div>
      <div className="text-[11px] text-[var(--color-text-tertiary)]">相同目录可被多个账号登记；目录文件共享，Relay 项目与会话仍各自独立。</div>
    </div>
  );
}
