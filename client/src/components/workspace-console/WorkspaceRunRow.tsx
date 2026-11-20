import type { WorkspaceConsoleRunDto } from '../../generated/relay-contracts';
import { formatClockTime, formatDateTime } from '../../utils/date-display';
import Tooltip from '../ui/Tooltip';
import { describeRun, describeRunCategory, describeRunListMetrics, describeRunMode, describeBusinessResult, describeRunScope, runMatchesFilter, formatRunDuration,describeRunAssociation,describeTestResult,describeTestErrors } from './run-presentation';

function cardTime(value: string | null): string {
  return value ? formatDateTime(new Date(value.replace(' ', 'T')), { short: true }) : '未记录';
}

function observationTime(value: string, startedAt: string | null): string {
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return '未记录';
  const started = startedAt ? new Date(startedAt.replace(' ', 'T')) : null;
  return started && !Number.isNaN(started.getTime()) && date.toDateString() === started.toDateString()
    ? formatClockTime(date) : cardTime(value);
}

export default function WorkspaceRunRow({ run, taskTitle, onOpen }: { run: WorkspaceConsoleRunDto; taskTitle?: string; onOpen: () => void }) {
  const description = describeRun(run);
  const metrics = describeRunListMetrics(run);
  const running = run.status.toLowerCase() === 'running';
  const abnormal = runMatchesFilter(run, 'abnormal');
  const business = describeBusinessResult(run);
  const scope = describeRunScope(run);
  const title=taskTitle||run.taskContext?.title||run.taskId||'未匹配任务';
  const association=describeRunAssociation(run),tests=describeTestResult(run),testErrors=describeTestErrors(run);
  const compactScope = run.operation?.objects.length===1 ? scope.find(line=>line.includes('：ID ')) ?? scope[0] : scope[0];
  const tone = abnormal ? 'border-rose-300/30 bg-rose-300/10 text-rose-200'
    : running ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200'
      : ['进程正常结束','测试通过'].includes(description.outcome) ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200' : 'border-white/15 bg-white/5 text-slate-300';
  const compact = running && run.source==='remote-runner' ? '登记运行中' : ({ '仅发现目录，暂无运行结果': '无结果', '最终状态未记录': '状态未记', '结果未记录': '未记录' } as Record<string, string>)[description.outcome] ?? description.outcome;
  const location = run.executionLocation === 'remote' ? '服务器' : run.executionLocation === 'local' ? '本机' : '位置未记录';
  const fallback = description.outcome === '进程正常结束' ? '业务完成情况未记录' : running ? '本机暂无可展示的进度结果' : description.outcome === '执行失败' ? '失败原因未记录' : '暂无结果摘要';
  return <button type="button" onClick={onOpen} className="block w-full min-w-0 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 text-left hover:border-cyan-300/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
    {title !== description.title && <span className="mb-1 block break-words text-[11px] text-slate-400">{title}</span>}
    {association&&<span className="mb-1 block text-[11px] text-amber-200">{association}</span>}
    <span className="flex min-w-0 flex-wrap items-start justify-between gap-1.5"><span className="min-w-0 flex-1 basis-40 whitespace-normal break-words text-xs font-medium text-slate-100">{description.title}</span><span className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] ${tone}`}>{compact}</span></span>
    <span className="mt-1 block break-words text-[11px] text-slate-400">{describeRunCategory(run)}{run.mode ? ` · ${describeRunMode(run)}` : ''}{run.operation?.plannedBusinessWrite===false?' · 计划不写业务数据':''}</span>
    {scope.length > 0 && <Tooltip content={scope.join('\n')} asChild><span className="mt-1 block truncate text-[11px] text-slate-300">{compactScope}</span></Tooltip>}
    {run.failureReason && <Tooltip overflowOnly content={run.failureReason} asChild><span className="mt-1 block line-clamp-2 break-words text-[11px] text-amber-200">{run.failureReason}</span></Tooltip>}
    {metrics && <span className="mt-1 block break-words text-[11px] text-slate-200">{metrics}</span>}
    {tests&&<span className="mt-1 block text-[11px] text-slate-200">{tests}</span>}
    {testErrors&&<span className="mt-1 block break-words text-[11px] text-amber-200">{testErrors}</span>}
    {business.length > 0 && <span className={`mt-1 block break-words text-[11px] ${abnormal || run.businessResult?.complete === false ? 'text-amber-200' : 'text-slate-200'}`}>{business.join(' · ')}</span>}
    {!run.failureReason && !metrics && !business.length && !tests && <span className="mt-1 block break-words text-[11px] text-slate-400">{fallback}</span>}
    {running && !run.resultMetrics?.items.length && !run.businessResult && <span className="mt-1 block text-[11px] text-amber-200">尚未采集执行进度，实际运行情况待核查</span>}
    <span className="mt-1 block break-words text-[11px] text-slate-500">{location} · 开始 {cardTime(run.startedAt)}{!running && run.durationSeconds !== null ? ` · 用时 ${formatRunDuration(run.durationSeconds)}` : ''}</span>
    {run.testResult&&<span className="mt-0.5 block truncate text-[10px] text-slate-500" title={run.runId}>运行编号：{run.runId}</span>}
    {running && <span className="mt-0.5 block break-words text-[11px] text-slate-500">{run.source === 'remote-runner' ? '最近核查' : '状态更新'}：{run.observedAt ? observationTime(run.observedAt, run.startedAt) : '时间未记录'}</span>}
  </button>;
}
