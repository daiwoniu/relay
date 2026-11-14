const aliases: Record<string, string> = {
  active: 'doing', in_progress: 'doing', review: 'review_pending',
  completed: 'done', canceled: 'cancelled',
};

const presentations: Record<string, { label: string; tone: string }> = {
  todo: { label: '待处理', tone: 'bg-slate-300/10 text-slate-200' },
  doing: { label: '处理中', tone: 'workspace-workbench__status-doing bg-cyan-300/10 text-cyan-200' },
  review_pending: { label: '待复核', tone: 'bg-violet-300/10 text-violet-200' },
  waiting: { label: '等待中', tone: 'bg-amber-300/10 text-amber-200' },
  blocked: { label: '已阻塞', tone: 'bg-rose-300/10 text-rose-200' },
  paused: { label: '已暂停', tone: 'bg-slate-400/15 text-slate-300' },
  done: { label: '已完成', tone: 'bg-emerald-300/10 text-emerald-200' },
  closed: { label: '已结束', tone: 'bg-zinc-300/10 text-zinc-300' },
  cancelled: { label: '已取消', tone: 'bg-zinc-300/10 text-zinc-300' },
  failed: { label: '失败', tone: 'bg-red-300/10 text-red-200' },
};

const unknownTone = 'bg-slate-400/10 text-slate-300';

export function taskStatusPresentation(status: string | null): { label: string; tone: string } {
  const known = presentations[aliases[status ?? ''] ?? status ?? ''];
  return known ?? { label: status && status !== 'unknown' ? status : '状态未登记', tone: unknownTone };
}
