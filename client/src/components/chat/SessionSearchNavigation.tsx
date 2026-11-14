import IconActionButton from '../ui/IconActionButton';
import { getSearchNavigationPosition } from './session-search-navigation';

export default function SessionSearchNavigation({
  currentIndex,
  loadedMatchCount,
  totalMatches,
  truncated,
  onPrevious,
  onNext,
  onClose,
}: {
  currentIndex: number;
  loadedMatchCount: number;
  totalMatches: number;
  truncated: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const position = getSearchNavigationPosition(currentIndex, loadedMatchCount, totalMatches);
  const title = truncated ? `仅可导航最近 ${loadedMatchCount} 条匹配消息` : '搜索匹配消息';
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--color-bg-secondary)] px-1 py-0.5" title={title} aria-label={title}>
      <span className="min-w-[3.25rem] px-1 text-center text-xs tabular-nums text-[var(--color-text-secondary)]">
        {position}/{totalMatches}
      </span>
      <IconActionButton label="上一处匹配" tooltipPlacement="bottom" className="h-7 w-7" disabled={currentIndex <= 0} onClick={onPrevious}>
        <span aria-hidden="true">↑</span>
      </IconActionButton>
      <IconActionButton label="下一处匹配" tooltipPlacement="bottom" className="h-7 w-7" disabled={currentIndex < 0 || currentIndex >= loadedMatchCount - 1} onClick={onNext}>
        <span aria-hidden="true">↓</span>
      </IconActionButton>
      <IconActionButton label="关闭消息搜索" tooltipPlacement="bottom" className="h-7 w-7" onClick={onClose}>
        <span aria-hidden="true">×</span>
      </IconActionButton>
    </div>
  );
}
