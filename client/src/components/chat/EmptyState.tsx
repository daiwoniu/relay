import Tooltip from '../ui/Tooltip';
import { Link } from 'react-router-dom';
import type { Session } from '../../stores/chat';
import RelayLogo from '../brand/RelayLogo';
import ToolboxIcon from '../icons/ToolboxIcon';
import { useChinaDayGreeting } from '../../hooks/useChinaDayGreeting';
import { buildEmptyStateToday } from './empty-state-today';

interface Props {
  isAdmin: boolean;
  recentSession: Session | null;
  onOpenRecentSession: (id: string) => void;
}

export default function EmptyState({ isAdmin, recentSession, onOpenRecentSession }: Props) {
  const { now, today, day, greeting, rotateGreeting } = useChinaDayGreeting();
  const view = buildEmptyStateToday(today, day, now.getHours());

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="my-auto flex shrink-0 flex-col items-center px-4 py-6 text-center">
        <div className="mb-5 flex items-center gap-1">
          <RelayLogo className="h-12 w-12 text-[var(--color-brand-mark)]" />
          <span className="text-[28px] font-semibold tracking-[-0.03em] text-[var(--color-text)]">Relay</span>
        </div>

        <h2 className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 text-xl font-semibold text-[var(--color-text)]">
          <span>{view.date}</span><span className="text-base font-normal text-[var(--color-text-secondary)]">{view.weekday}</span>
        </h2>
        {(view.lunar || view.festivals.length > 0 || view.solarTerm || view.holiday) && (
          <div className="mt-3 flex max-w-lg flex-wrap justify-center gap-2 text-xs text-[var(--color-text-secondary)]">
            {view.lunar && <span className="rounded-full border border-[var(--color-border)] px-2.5 py-1">{view.lunar}</span>}
            {view.festivals.map((festival) => <span key={festival} className="rounded-full border border-[var(--color-border)] px-2.5 py-1">{festival}</span>)}
            {view.solarTerm && <span className="rounded-full border border-[var(--color-border)] px-2.5 py-1">节气 · {view.solarTerm}</span>}
            {view.holiday && <span className="rounded-full border border-[var(--color-border)] px-2.5 py-1">{view.holiday}</span>}
          </div>
        )}
        {view.weather && <p className="mt-3 text-sm text-[var(--color-text-secondary)]">{view.weather}</p>}
        <span onClick={rotateGreeting} className="mt-3 inline-block cursor-pointer text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">{greeting}</span>

        <nav aria-label="快捷导航" className={`mt-7 w-full max-w-[320px] ${isAdmin ? 'sm:max-w-xl' : 'sm:max-w-sm'}`}>
          <div className={`grid grid-cols-1 gap-3 ${isAdmin ? 'sm:grid-cols-2' : ''}`}>
            {isAdmin && (
              <Link to="/admin/task-workbench" target="_blank" rel="noopener noreferrer" className="group flex min-w-0 items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 text-left transition-colors hover:border-[var(--color-primary)]/45 hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] group-hover:text-[var(--color-text)]">
                  <svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="6" height="6" rx="1.25" stroke="currentColor" strokeWidth="1.5" /><rect x="11.5" y="2.5" width="6" height="6" rx="1.25" stroke="currentColor" strokeWidth="1.5" /><rect x="2.5" y="11.5" width="6" height="6" rx="1.25" stroke="currentColor" strokeWidth="1.5" /><rect x="11.5" y="11.5" width="6" height="6" rx="1.25" stroke="currentColor" strokeWidth="1.5" /></svg>
                </span>
                <span className="min-w-0"><span className="block text-sm font-medium text-[var(--color-text)]">任务工作台</span><span className="mt-0.5 block text-xs text-[var(--color-text-secondary)]">查看任务与用量</span></span>
              </Link>
            )}
            <Link to="/tools" target="_blank" rel="noopener noreferrer" className="group flex min-w-0 items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 text-left transition-colors hover:border-[var(--color-primary)]/45 hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] group-hover:text-[var(--color-text)]">
                <ToolboxIcon />
              </span>
              <span className="min-w-0"><span className="block text-sm font-medium text-[var(--color-text)]">工具集</span><span className="mt-0.5 block text-xs text-[var(--color-text-secondary)]">资讯、日历与日常工具</span></span>
            </Link>
          </div>
          {recentSession && (
            <Tooltip content={recentSession.title} asChild><button type="button" onClick={() => onOpenRecentSession(recentSession.id)} className="mx-auto mt-4 flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" /><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span className="shrink-0">继续最近会话 ·</span><span className="truncate">{recentSession.title || '新对话'}</span>
            </button></Tooltip>
          )}
        </nav>
      </div>
    </div>
  );
}
