import { useState } from 'react';
import type { TokenUsageDto } from '../../generated/relay-contracts';
import DetailsDialog from '../layout/DetailsDialog';
import HoverCard from '../ui/HoverCard';
import { getTokenUsagePresentation, type TokenUsagePresentation } from './token-usage-presentation';

function TokenUsageDetails({ presentation }: { presentation: TokenUsagePresentation }) {
  const rows = [
    ['累计输出 Tokens', presentation.outputTokens],
    ['其中累计推理 Tokens', presentation.reasoningOutputTokens],
    ['累计其他输出 Tokens', presentation.nonReasoningOutputTokens],
  ] as const;

  return (
    <div className="w-max max-w-full space-y-2.5 text-xs">
      <dl className="grid grid-cols-[1fr_auto] gap-x-5 gap-y-1.5">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="col-span-2 grid grid-cols-subgrid"
          >
            <dt className="whitespace-nowrap text-[var(--color-text-secondary)]">{label}</dt>
            <dd className="select-all whitespace-nowrap text-right font-medium tabular-nums text-[var(--color-text)]">
              {value.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-[var(--color-border-light)] pt-2 leading-5 text-[var(--color-text-tertiary)]">
        本轮数值按多次模型调用的过程快照累加估算；输出包含不可见推理，其他输出也可能包含工具调用参数，不等于页面文字数量。
      </p>
    </div>
  );
}

export default function TokenUsageSummary({ tokenUsage, mobile }: { tokenUsage: TokenUsageDto; mobile: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const presentation = getTokenUsagePresentation(tokenUsage);
  const details = <TokenUsageDetails presentation={presentation} />;

  return (
    <>
      <HoverCard
        disabled={mobile}
        delay={300}
        placement="top"
        title="本轮累计输出用量（估算）"
        content={details}
        maxWidth="min(22rem, calc(100vw - 1rem))"
        openOnClick
      >
        <button
          type="button"
          className="assistant-message__usage"
          aria-label={`查看本轮累计输出用量估算，输出约 ${presentation.outputTokens.toLocaleString()}`}
          onClick={() => { if (mobile) setDetailsOpen(true); }}
        >
          输出 ≈ {presentation.outputTokens.toLocaleString()}
        </button>
      </HoverCard>

      {detailsOpen && (
        <DetailsDialog
          open
          title="本轮累计输出用量（估算）"
          onClose={() => setDetailsOpen(false)}
        >
          {details}
        </DetailsDialog>
      )}
    </>
  );
}
