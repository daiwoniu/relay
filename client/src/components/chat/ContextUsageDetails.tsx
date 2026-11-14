import type { TokenUsageDto } from '../../generated/relay-contracts';
import type { ContextUsagePresentation } from './context-usage-presentation';

interface Props {
  contextUsage: ContextUsagePresentation;
  tokenUsage?: TokenUsageDto;
  count: number;
  mobile: boolean;
  actionDisabled: boolean;
  actionLabel: string;
  onAction: (sourceElement: HTMLButtonElement) => void;
}

export default function ContextUsageDetails({
  contextUsage,
  tokenUsage,
  count,
  mobile,
  actionDisabled,
  actionLabel,
  onAction,
}: Props) {
  const notice = contextUsage.riskNotice;

  return (
    <div className="min-w-0 space-y-2.5 text-xs">
      {!tokenUsage ? (
        <>
          <div className="font-medium text-[var(--color-text)]">{contextUsage.emptyTitle}</div>
          <p className="leading-5 text-[var(--color-text-tertiary)]">
            {contextUsage.emptyDescription}
          </p>
        </>
      ) : (
        <>
          <div className="text-[11px] font-medium text-[var(--color-text-tertiary)]">
            {contextUsage.scopeLabel}
          </div>
          <div className="font-medium text-[var(--color-text)]">
            {contextUsage.percent === null
              ? `已使用 ${tokenUsage.totalTokens.toLocaleString()} Tokens`
              : `已用 ${contextUsage.percent}% · 剩余 ${contextUsage.remainingPercent}%`}
          </div>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 sm:gap-x-5">
            <div className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-[var(--color-text-secondary)]">上下文占用</dt>
              <dd className="select-all whitespace-nowrap text-right font-medium tabular-nums text-[var(--color-text)]">
                {tokenUsage.totalTokens.toLocaleString()}
                {contextUsage.contextWindow ? ` / ${contextUsage.contextWindow.toLocaleString()}` : ' / 上限未知'}
              </dd>
            </div>
            <div className="col-span-2 mt-1 grid grid-cols-subgrid border-t border-[var(--color-border-light)] pt-2">
              <dt className="whitespace-nowrap text-[var(--color-text-secondary)]">模型输入（含上下文）</dt>
              <dd className="select-all whitespace-nowrap text-right font-medium tabular-nums text-[var(--color-text)]">
                {tokenUsage.inputTokens.toLocaleString()}
              </dd>
            </div>
            <div className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-[var(--color-text-secondary)]">其中缓存输入</dt>
              <dd className="select-all whitespace-nowrap text-right font-medium tabular-nums text-[var(--color-text)]">
                {tokenUsage.cachedInputTokens.toLocaleString()}
              </dd>
            </div>
          </dl>
          <p className="border-t border-[var(--color-border-light)] pt-2 leading-5 text-[var(--color-text-tertiary)]">
            模型输入包含当前回合携带的历史上下文；缓存输入已包含在模型输入中，并仍计入上下文占用。
          </p>
        </>
      )}

      {count > 0 && (
        <div className="border-t border-[var(--color-border-light)] pt-2">
          <div className="font-medium text-[var(--color-text)]">上下文已自动整理 {count} 次</div>
          <p className="mt-1 leading-5 text-[var(--color-text-tertiary)]">较早内容已被摘要，以便继续当前会话。</p>
        </div>
      )}

      <section
        aria-label="会话交接"
        className={`rounded-lg border p-2.5 ${notice?.level === 'danger'
          ? 'border-[var(--color-status-danger)]/30 bg-[var(--color-danger-hover)]'
          : notice?.level === 'warning'
            ? 'border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)]'
            : 'border-[var(--color-border-light)] bg-[var(--color-surface)]'}`}
      >
        <div className={`font-medium ${notice?.level === 'danger'
          ? 'text-[var(--color-status-danger)]'
          : notice?.level === 'warning'
            ? 'text-[var(--color-status-warning)]'
            : 'text-[var(--color-text)]'}`}
        >
          {notice?.title ?? contextUsage.handoffAction.title}
        </div>
        <p className="mt-1 leading-5 text-[var(--color-text-secondary)]">
          {notice?.description ?? contextUsage.handoffAction.description}
        </p>
        <button
          type="button"
          data-overlay-ignore
          disabled={actionDisabled}
          onClick={(event) => onAction(event.currentTarget)}
          className={`context-usage-action ${mobile ? 'min-h-9 w-full' : 'min-h-8 w-auto'}`}
        >
          {actionLabel}
        </button>
      </section>
    </div>
  );
}
