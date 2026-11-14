import type { EngineId } from '../../generated/relay-contracts';
import { getEnginePresentation } from '../../engine/catalog';

export default function SessionEngineBadge({ engine, size = 'compact' }: { engine: EngineId; size?: 'compact' | 'menu' | 'panel' }) {
  const presentation = getEnginePresentation(engine);
  const sizeClass = size === 'panel'
    ? 'h-8 min-w-8 rounded-lg px-1.5 text-[10px]'
    : size === 'menu'
      ? 'h-[14px] w-[14px] rounded-[3px] text-[7px]'
    : 'h-4 min-w-4 rounded px-1 text-[8px]';
  const textClass = size === 'menu'
    ? 'font-bold tracking-normal'
    : 'font-semibold tracking-tight shadow-sm';
  return (
    <span
      title={presentation.label}
      className={`inline-flex shrink-0 items-center justify-center border border-white/25 leading-none text-white ${sizeClass} ${textClass}`}
      style={{ backgroundColor: presentation.badgeColor }}
    >
      {presentation.shortName}
    </span>
  );
}
