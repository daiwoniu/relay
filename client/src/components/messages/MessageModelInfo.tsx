import { useState } from 'react';
import type { MessageModelInfoDto, ModelExecutionDescriptorDto, RequestedModelExecutionDescriptorDto } from '../../generated/relay-contracts';
import { reasoningEffortToChinese } from '../chat/model-settings-presentation';
import DetailsDialog from '../layout/DetailsDialog';
import HoverCard from '../ui/HoverCard';
import { modelDetailRows } from './message-model-info-presentation';

function descriptorLabel(descriptor: ModelExecutionDescriptorDto | RequestedModelExecutionDescriptorDto) {
  const reasoning = reasoningEffortToChinese(descriptor.reasoningEffort || '');
  return reasoning ? `${descriptor.displayName || descriptor.id} · ${reasoning}` : descriptor.displayName || descriptor.id;
}

function ModelInfoDetails({ modelInfo }: { modelInfo: MessageModelInfoDto }) {
  return <div className="min-w-0 space-y-2 text-xs">
    {modelDetailRows(modelInfo).map((row) => <div key={row.label}><div className="text-[var(--color-text-tertiary)]">{row.label}</div><div className="break-words font-medium text-[var(--color-text)]">{row.value}</div></div>)}
    {modelInfo.effective.provider && <div><span className="text-[var(--color-text-tertiary)]">提供商：</span><span className="text-[var(--color-text-secondary)]">{modelInfo.effective.provider}</span></div>}
    {modelInfo.rerouted && modelInfo.requested && <div className="border-t border-[var(--color-border-light)] pt-2"><div className="text-[var(--color-text-tertiary)]">本轮请求</div><div className="break-words text-[var(--color-text-secondary)]">{descriptorLabel(modelInfo.requested)}</div></div>}
    {modelInfo.rerouted && <div className="text-[var(--color-status-warning)]">引擎已根据可用性调整本轮模型。</div>}
  </div>;
}

export default function MessageModelInfo({ modelInfo, mobile = false, readOnly = false }: { modelInfo: MessageModelInfoDto; mobile?: boolean; readOnly?: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const label = descriptorLabel(modelInfo.effective);
  const ariaLabel = `本轮模型：${label}${modelInfo.rerouted ? '，已调整' : ''}`;
  if (readOnly) return <details className="message-model-info min-w-0 text-xs text-[var(--color-text-secondary)]"><summary className="cursor-pointer break-words" aria-label={ariaLabel}>{label}{modelInfo.rerouted ? ' · 已调整' : ''}</summary><div className="mt-2 rounded-lg border border-[var(--color-border)] p-2"><ModelInfoDetails modelInfo={modelInfo} /></div></details>;
  const trigger = <button type="button" onClick={() => { if (mobile) setDetailsOpen(true); }} aria-label={ariaLabel} className="flex min-w-0 max-w-full items-center gap-1 rounded-sm text-[var(--color-text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"><span className="min-w-0 truncate whitespace-nowrap">{label}</span>{modelInfo.rerouted && <span className="shrink-0" aria-hidden="true">· 已调整</span>}</button>;
  return <div className="message-model-info min-w-0 overflow-hidden">
    <HoverCard disabled={mobile} placement="top" title="本轮模型" openOnClick content={<ModelInfoDetails modelInfo={modelInfo} />}>{trigger}</HoverCard>
    {mobile && <DetailsDialog open={detailsOpen} onClose={() => setDetailsOpen(false)} title="本轮模型"><ModelInfoDetails modelInfo={modelInfo} /></DetailsDialog>}
  </div>;
}
