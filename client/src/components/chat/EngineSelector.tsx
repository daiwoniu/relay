import Tooltip from '../ui/Tooltip';
import { useCallback, useState } from 'react';
import type { EngineId, EngineStatusDto } from '../../generated/relay-contracts';
import Popover from '../ui/Popover';
import PopoverSection from '../ui/PopoverSection';
import { formatEngineUnavailableReason, formatEngineVersion } from './engine-selector-presentation';
import SessionEngineBadge from './SessionEngineBadge';
import { recheckEngineReadiness } from '../../api/system';
import { getEnginePresentation } from '../../engine/catalog';

// 支持「就绪复验」内联快捷操作的引擎：codex 无 recheck 动作，排除。
const RECHECK_CAPABLE_ENGINES = new Set<EngineId>(['codebuddy', 'opencode', 'zcode']);

export function engineLabel(engine: EngineId): string {
  return getEnginePresentation(engine).label;
}

interface Props {
  value: EngineId | null;
  statuses: EngineStatusDto[];
  locked: boolean;
  mobile?: boolean;
  fallbackNotice?: string | null;
  onChange: (engine: EngineId) => () => void;
  onStatusesChange?: (statuses: EngineStatusDto[]) => void;
}

export default function EngineSelector({ value, statuses, locked, mobile = false, fallbackNotice, onChange, onStatusesChange }: Props) {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [rechecking, setRechecking] = useState<EngineId | null>(null);
  const currentStatus = statuses.find((status) => status.id === value);
  const displayedStatuses = locked && currentStatus ? [currentStatus] : statuses;
  const close = useCallback(() => setAnchorRect(null), []);

  return (
    <div className={`relative flex min-w-0 items-center gap-1.5 whitespace-nowrap max-w-[45%] overflow-hidden ${mobile ? 'shrink-0' : 'shrink'}`}>
      <Tooltip content={fallbackNotice || (locked ? '查看会话引擎' : '选择新会话引擎')} asChild><button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={anchorRect !== null}
        aria-label={locked && value ? `查看 ${engineLabel(value)} 引擎详情` : '选择 AI 引擎'}
        onClick={(event) => {
          const next = event.currentTarget.getBoundingClientRect();
          setAnchorRect((current) => current ? null : next);
        }}
        className={`composer-compact-trigger group flex min-w-0 items-center gap-1 text-xs ${mobile ? 'shrink-0' : ''}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${currentStatus?.available ? 'bg-[var(--color-status-success)]' : 'bg-[var(--color-text-tertiary)]'}`} aria-hidden="true" />
        <span className={`${mobile ? 'shrink-0' : 'truncate'} font-medium`}>{statuses.length === 0 ? '正在检查可用引擎…' : value ? (mobile ? getEnginePresentation(value).shortName : engineLabel(value)) : '选择 AI 引擎'}</span>
        {!locked && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="text-[var(--color-text-tertiary)] transition-transform group-aria-expanded:rotate-180" aria-hidden="true">
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button></Tooltip>
      {fallbackNotice && <span className="hidden text-[11px] text-[var(--color-status-warning)] sm:inline">已临时回退</span>}

      <Popover
        open={anchorRect !== null}
        anchorRect={anchorRect}
        onClose={close}
        placement="top"
        mobile={mobile}
        mobilePresentation="sheet"
        label={locked ? '引擎详情' : '选择 AI 引擎'}
        className={mobile ? '' : 'w-[min(21rem,calc(100vw-1.5rem))]'}
      >
        <PopoverSection title={locked ? '引擎详情' : '选择 AI 引擎'} description={locked ? '固定使用所选引擎，无法更改' : '开始会话后将固定使用所选引擎，无法更改'} bodyClassName="max-h-[min(22rem,55vh)] overflow-y-auto p-2"
          footer={<button type="button" className="popover-action-row min-h-11" onClick={() => {
            close();
            window.dispatchEvent(new CustomEvent('relay:open-engine-maintenance'));
          }}>查看引擎状态</button>}>
        <div role="listbox" aria-label="AI 引擎列表" className="space-y-1">
          {statuses.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-[var(--color-text-tertiary)]">正在检查可用引擎…</div>
          ) : displayedStatuses.map((status) => {
            const selected = status.id === value;
            const brand = getEnginePresentation(status.id);
            const unavailable = !status.available;
            const version = formatEngineVersion(status.version);
            const unavailableReason = unavailable ? formatEngineUnavailableReason(status.availabilityStage, status.code, status.message) : null;
            return (
              <button
                key={status.id}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={locked || unavailable}
                aria-busy={rechecking === status.id}
                disabled={locked || (rechecking !== null && rechecking !== status.id)}
                onClick={async () => {
                  if (unavailable) {
                    if ((status.availabilityStage === 'readiness_stale' || status.availabilityStage === 'readiness_failed') && RECHECK_CAPABLE_ENGINES.has(status.id)) {
                      setRechecking(status.id);
                      const commitSelection = onChange(status.id);
                      try {
                        const response = await recheckEngineReadiness(status.id);
                        onStatusesChange?.(response.engines);
                        const refreshed = response.engines.find((candidate) => candidate.id === status.id);
                        if (!refreshed?.available) throw new Error();
                        commitSelection();
                        close();
                      } catch {
                        // 保留待复验状态，允许用户再次点击。
                      } finally {
                        setRechecking(null);
                      }
                      return;
                    }
                    window.dispatchEvent(new CustomEvent('relay:open-engine-maintenance', { detail: { engineId: status.id } }));
                    close();
                    return;
                  }
                  onChange(status.id)();
                  close();
                }}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${selected
                  ? 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]'
                  : 'border-transparent hover:border-[var(--color-border-light)] hover:bg-[var(--color-surface-hover)]'} ${unavailable ? 'cursor-pointer' : ''} disabled:cursor-default disabled:opacity-100`}
              >
                <SessionEngineBadge engine={status.id} size="panel" />
                <span className="flex min-w-0 flex-1 flex-col justify-center">
                  <span className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate font-medium text-[var(--color-text)]">{status.label}</span>
                      {version && <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">{version}</span>}
                      {unavailableReason && <span className="shrink-0 text-[11px] text-[var(--color-status-warning)]">{rechecking === status.id ? '检测中…' : unavailableReason}</span>}
                    </span>
                    {selected && (
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-text)]" aria-hidden="true">
                        <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--color-text-secondary)]">{brand.vendor} · {brand.position}</span>
                </span>
              </button>
            );
          })}
        </div>
        </PopoverSection>
      </Popover>
    </div>
  );
}
