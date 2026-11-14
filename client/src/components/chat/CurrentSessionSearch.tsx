import { useEffect, useRef, useState } from 'react';
import IconActionButton from '../ui/IconActionButton';
import FailureNotice from '../ui/FailureNotice';
import Popover from '../ui/Popover';
import type { SessionSearchStatus } from '../../stores/session-search';
import { getSearchNavigationPosition } from './session-search-navigation';

interface Props {
  open: boolean;
  query: string;
  status: SessionSearchStatus;
  error: string | null;
  historyStatus: 'idle' | 'loading' | 'error';
  currentIndex: number;
  loadedMatchCount: number;
  totalMatches: number;
  truncated: boolean;
  includeProcess: boolean;
  includeOperations: boolean;
  mobile: boolean;
  onOpen: () => void;
  onQueryChange: (query: string) => void;
  onIncludeProcessChange: (enabled: boolean) => void;
  onIncludeOperationsChange: (enabled: boolean) => void;
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
  onRetryHistory: () => void;
  onInputFocusChange: (focused: boolean) => void;
  onClose: () => void;
}

const SearchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <circle cx="7.75" cy="7.75" r="4.75" stroke="currentColor" strokeWidth="1.5" />
    <path d="M11.25 11.25L15 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export default function CurrentSessionSearch(props: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [filterAnchor, setFilterAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  if (!props.open) {
    return (
      <IconActionButton
        label="搜索当前会话消息"
        variant="neutral"
        tooltipPlacement="bottom"
        onClick={props.onOpen}
      >
        <SearchIcon />
      </IconActionButton>
    );
  }

  const position = getSearchNavigationPosition(props.currentIndex, props.loadedMatchCount, props.totalMatches);
  const includesExtendedResults = props.includeProcess || props.includeOperations;
  const countUnit = includesExtendedResults
    ? (props.mobile ? '项' : '个结果')
    : (props.mobile ? '条' : '条消息');
  const truncatedTitle = includesExtendedResults
    ? `仅可导航最近 ${props.loadedMatchCount} 个搜索结果`
    : `仅可导航最近 ${props.loadedMatchCount} 条匹配消息`;
  const countLabel = props.status === 'loading'
    ? '搜索中…'
    : props.status === 'error'
      ? '搜索失败'
      : props.historyStatus === 'loading'
        ? '加载历史…'
        : props.historyStatus === 'error'
          ? '加载失败'
      : `${position}/${props.totalMatches} ${countUnit}`;
  const countAriaLabel = props.status === 'loading'
    ? '正在搜索当前会话'
    : props.status === 'error'
      ? '当前会话搜索失败'
      : props.historyStatus === 'loading'
        ? '正在加载目标消息之前的历史记录'
        : props.historyStatus === 'error'
          ? '历史消息加载失败'
          : props.totalMatches === 0
            ? (includesExtendedResults ? '没有搜索结果' : '没有命中消息')
            : includesExtendedResults
              ? `第 ${position} 项，共 ${props.totalMatches} 个搜索结果`
              : `第 ${position} 条，共 ${props.totalMatches} 条命中消息`;
  const navigationDisabled = props.historyStatus !== 'idle';

  return (
    <div className="flex h-8 w-full min-w-0 items-center gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1 shadow-sm">
      <span className="ml-1 shrink-0 text-[var(--color-text-tertiary)]"><SearchIcon /></span>
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        value={props.query}
        onFocus={() => props.onInputFocusChange(true)}
        onBlur={() => props.onInputFocusChange(false)}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            props.onClose();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) props.onPrevious(); else props.onNext();
          }
        }}
        placeholder="在当前会话中搜索…"
        aria-label="搜索当前会话消息"
        className="min-w-0 flex-1 bg-transparent px-1 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-tertiary)]"
      />
      <IconActionButton
        label="搜索范围"
        variant="neutral"
        tooltipPlacement="bottom"
        className={(props.includeProcess || props.includeOperations) ? 'text-[var(--color-accent)]' : ''}
        aria-expanded={filterAnchor !== null}
        onClick={(event) => setFilterAnchor(filterAnchor ? null : event.currentTarget.getBoundingClientRect())}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </IconActionButton>
      <span
        className={`shrink-0 text-center text-[11px] tabular-nums ${props.historyStatus === 'idle' ? (props.mobile ? 'min-w-[3rem]' : 'min-w-[5rem]') : 'min-w-[4.5rem]'} ${(props.status === 'error' || props.historyStatus === 'error') ? 'text-[var(--color-status-danger)]' : 'text-[var(--color-text-secondary)]'}`}
        aria-label={countAriaLabel}
        title={props.historyStatus === 'loading' ? '正在加载目标消息之前的历史记录' : props.historyStatus === 'error' ? '历史消息加载失败，请重试' : props.truncated ? truncatedTitle : props.error || undefined}
      >
        {countLabel}
      </span>
      {props.status === 'error' && (
        <IconActionButton label="重试搜索" variant="neutral" tooltipPlacement="bottom" onClick={props.onRetry}>
          <span aria-hidden="true">↻</span>
        </IconActionButton>
      )}
      {(props.status === 'error' || props.historyStatus === 'error') && <details className="max-w-xs text-xs text-[var(--color-status-danger)]"><summary className="cursor-pointer">异常详情与处理建议</summary><FailureNotice error={props.error || '历史消息加载失败，服务未提供具体异常'} /></details>}
      {props.historyStatus === 'error' && (
        <IconActionButton label="重试加载历史消息" variant="neutral" tooltipPlacement="bottom" onClick={props.onRetryHistory}>
          <span aria-hidden="true">↻</span>
        </IconActionButton>
      )}
      <IconActionButton label="上一处匹配" variant="neutral" tooltipPlacement="bottom" disabled={navigationDisabled || props.currentIndex <= 0} onClick={props.onPrevious}>
        <span aria-hidden="true">↑</span>
      </IconActionButton>
      <IconActionButton label="下一处匹配" variant="neutral" tooltipPlacement="bottom" disabled={navigationDisabled || props.currentIndex < 0 || props.currentIndex >= props.loadedMatchCount - 1} onClick={props.onNext}>
        <span aria-hidden="true">↓</span>
      </IconActionButton>
      <IconActionButton label="关闭消息搜索" variant="neutral" tooltipPlacement="bottom" onClick={props.onClose}>
        <span aria-hidden="true">×</span>
      </IconActionButton>

      <Popover
        open={filterAnchor !== null}
        anchorRect={filterAnchor}
        onClose={() => setFilterAnchor(null)}
        placement="bottom"
        mobile={false}
        label="当前会话搜索范围"
        className="w-64 p-2"
      >
        <div className="px-2 pb-1.5 pt-1 text-xs font-medium text-[var(--color-text-secondary)]">搜索范围</div>
        <label className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-text)] opacity-70">
          <input type="checkbox" checked readOnly />
          <span>主要消息</span><span className="ml-auto text-xs text-[var(--color-text-tertiary)]">始终包含</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]">
          <input type="checkbox" checked={props.includeProcess} onChange={(event) => props.onIncludeProcessChange(event.target.checked)} />
          <span>包含处理过程</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]">
          <input type="checkbox" checked={props.includeOperations} onChange={(event) => props.onIncludeOperationsChange(event.target.checked)} />
          <span>包含操作详情</span>
        </label>
        <p className="mx-2 mt-1 border-t border-[var(--color-border)] pt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
          按命中的消息或内容项计数，同一项中多次出现只计一次。
        </p>
      </Popover>
    </div>
  );
}
