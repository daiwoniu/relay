import type { RegionLoadState } from '../../stores/region-load-state';
import { getSidebarRegionPresentation } from './sidebar-region-loading';
import FailureNotice from '../ui/FailureNotice';

export default function SidebarLoadingState({
  state,
  hasContent,
  onRetry,
}: {
  state: RegionLoadState;
  hasContent: boolean;
  onRetry: () => void;
}) {
  const presentation = getSidebarRegionPresentation(state, hasContent);
  if (presentation === 'ready') return null;
  if (presentation === 'loading_cached') {
    return <div className="sidebar-navigation-state sidebar-navigation-state--inline" role="status">正在更新导航…</div>;
  }
  if (presentation === 'loading_empty') {
    return (
      <div className="sidebar-navigation-skeleton space-y-1 px-1 py-2" role="status" aria-label="正在加载项目和会话">
        <div className="sidebar-navigation-skeleton__row h-8 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
        <div className="sidebar-navigation-skeleton__row h-8 w-5/6 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
        <div className="sidebar-navigation-skeleton__row h-8 w-2/3 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
      </div>
    );
  }
  return (
    <div role="alert" className="sidebar-navigation-state sidebar-navigation-state--error mx-1 my-2">
      <div><FailureNotice error={state.error || '导航加载失败'} /></div>
      <button type="button" onClick={onRetry} className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 hover:bg-[var(--color-sidebar-hover)]">重新加载导航</button>
    </div>
  );
}
