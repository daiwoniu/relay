import { useRef, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';
import FailureNotice from './FailureNotice';

export function ListSearchField({
  value,
  onChange,
  onClear,
  placeholder,
  label,
  clearLabel = '清除搜索',
  disabled = false,
  compact = false,
  className = '',
  onCommit,
}: {
  onCommit?:()=>void;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  placeholder: string;
  label: string;
  clearLabel?: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const committedValue=useRef(value);
  const commit=()=>{if(value!==committedValue.current){committedValue.current=value;onCommit?.();}};
  const change = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value);
  const clear = () => {
    committedValue.current='';
    onClear();
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if(event.key==='Enter')commit();
    if (event.key === 'Escape' && value) {
      event.preventDefault();
      clear();
    }
  };

  return <div className={`ui-list-search${compact ? ' ui-list-search--compact' : ''} ${className}`.trim()}>
    <svg viewBox="0 0 16 16" fill="none" className="ui-list-search__icon" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
    <input
      ref={inputRef}
      type="search"
      enterKeyHint="search"
      value={value}
      onChange={change}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      aria-label={label}
      disabled={disabled}
      className="ui-list-search__input"
    />
    {value && <button type="button" onClick={clear} aria-label={clearLabel} disabled={disabled} className="ui-list-search__clear"><span aria-hidden="true">×</span></button>}
  </div>;
}

export function ListState({
  kind,
  title,
  detail,
  icon,
  onRetry,
  retryLabel = '重新加载',
  compact = false,
  className = '',
}: {
  kind: 'loading' | 'error' | 'empty';
  title: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
  className?: string;
}) {
  return <div
    role={kind === 'error' ? 'alert' : 'status'}
    aria-live={kind === 'error' ? 'assertive' : 'polite'}
    className={`ui-list-state ui-list-state--${kind}${compact ? ' ui-list-state--compact' : ''} ${className}`.trim()}
  >
    {icon && <span className="ui-list-state__icon" aria-hidden="true">{icon}</span>}
    <div className="ui-list-state__title">{title}</div>
    {detail && <div className="ui-list-state__detail">{kind === 'error' && typeof detail === 'string' ? <FailureNotice error={detail} /> : detail}</div>}
    {onRetry && <button type="button" onClick={onRetry} className="ui-list-state__retry">{retryLabel}</button>}
  </div>;
}

export function ListPagination({
  start,
  end,
  total,
  hasPrevious,
  hasNext,
  loading = false,
  onPrevious,
  onNext,
  className = '',
}: {
  start: number;
  end: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
  loading?: boolean;
  onPrevious: () => void;
  onNext: () => void;
  className?: string;
}) {
  return <div className={`ui-list-pagination ${className}`.trim()} aria-busy={loading}>
    <span className="ui-list-pagination__summary">第 {start}–{end} 条，共 {total} 条</span>
    <div className="ui-list-pagination__actions">
      <button type="button" disabled={loading || !hasPrevious} onClick={onPrevious} className="ui-list-pagination__button">上一页</button>
      <button type="button" disabled={loading || !hasNext} onClick={onNext} className="ui-list-pagination__button">下一页</button>
    </div>
  </div>;
}
