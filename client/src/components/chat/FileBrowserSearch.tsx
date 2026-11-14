import IconActionButton from '../ui/IconActionButton';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  disabled?: boolean;
}

interface ButtonProps {
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function FileBrowserSearchButton({ open, onToggle, disabled = false }: ButtonProps) {
  return (
    <IconActionButton
      label={open ? '关闭搜索' : '搜索当前目录'}
      variant="neutral"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={open}
      className={open ? 'bg-[var(--color-surface-hover)] text-[var(--color-text)]' : ''}
    >
      <SearchIcon />
    </IconActionButton>
  );
}

export default function FileBrowserSearch({ value, onChange, onClose, disabled = false }: Props) {
  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"><SearchIcon /></span>
        <input
          type="search"
          enterKeyHint="search"
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
          disabled={disabled}
          aria-label="搜索当前目录"
          placeholder="搜索当前目录"
          className="w-full appearance-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-9 pr-9 text-sm text-[var(--color-text)] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-focus-ring)] focus:ring-2 focus:ring-[var(--color-focus-ring)]/20 disabled:opacity-60"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="清除搜索"
            className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M4 4l6 6m0-6l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
