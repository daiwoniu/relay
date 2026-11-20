import type { WorkspaceConsoleRunDto } from '../../generated/relay-contracts';

const outcomes: Record<string, string> = {
  succeeded: '进程正常结束', success: '进程正常结束', done: '进程正常结束', completed: '进程正常结束',
  failed: '执行失败', error: '执行失败', running: '记录为运行中', pending: '待运行', prepared: '已准备',
  lost: '执行失联', stopped: '已停止',
  cancelled: '已取消', canceled: '已取消',
};

const remoteTargets: Record<string, string> = {
  'tanji-executed-history-sample': '历史被执行人样本导出',
  'tanji-executed-mapping-canary': '旧 ID 映射核查',
  'tanji-executed-mapping-full': '旧 ID 映射全量处理',
};

const modeLabels: Record<string, string> = {
  'dry-run': '预演模式', execute: '执行模式', sample: '样本', repair: '修复', test: '测试',
};

export function formatRunDuration(seconds: number | null): string {
  if (seconds === null) return '未记录';
  if (seconds < 1 && seconds > 0) return `${seconds.toFixed(1)} 秒`;
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  const parts = [hours ? `${hours} 小时` : null, minutes ? `${minutes} 分` : null, remainder ? `${remainder} 秒` : null].filter(Boolean);
  if (!parts.length) return '0 秒';
  return remainder ? parts.join(' ') : `${parts.join(' ')}${hours ? '' : '钟'}`;
}

export function describeRunMetrics(run: WorkspaceConsoleRunDto): { sourceLabel: string; summary: string; totals: string[]; conditions: string[] } | null {
  const metrics = run.resultMetrics;
  if (!metrics?.items.length) return null;
  const format = (item: (typeof metrics.items)[number]) => `${item.label} ${item.value.toLocaleString('zh-CN')} 条`;
  const totals = metrics.items.filter((item) => item.kind !== 'condition').map(format);
  const conditions = metrics.items.filter((item) => item.kind === 'condition').map(format);
  const sourceLabel = metrics.source === 'progress' ? '执行进度' : metrics.source === 'summary' ? '执行摘要' : '执行记录';
  return { sourceLabel, summary: [...totals.slice(0, 3), ...conditions.slice(0, 1)].join(' · '), totals, conditions };
}

export function describeRunListMetrics(run: WorkspaceConsoleRunDto): string | null {
  const items = run.resultMetrics?.items;
  if (!items?.length) return [run.updatedRows !== null ? `已更新 ${run.updatedRows.toLocaleString('zh-CN')} 条` : null,
    run.insertedRows !== null ? `已插入 ${run.insertedRows.toLocaleString('zh-CN')} 条` : null].filter(Boolean).join(' · ') || null;
  if (items.some(item => ['关联修订','字段修正','旧记录标记'].includes(item.label))) {
    return items.filter(item => item.kind !== 'condition').map(item=>`${item.label} ${item.value.toLocaleString('zh-CN')} 条`).join(' · ');
  }
  const preferred = run.mode?.toLowerCase() === 'dry-run'
    ? ['已处理', '已扫描', '计划修复', '已导出', '探查取得', '已更新', '已插入']
    : ['已更新', '已插入', '已导出', '已处理', '已扫描', '计划修复', '探查取得'];
  const ranked = [...items].sort((a, b) => {
    const rank = (item: typeof a) => (item.kind === 'condition' ? 200 : (preferred.indexOf(item.label) < 0 ? 50 : preferred.indexOf(item.label))) + (item.value === 0 ? 100 : 0);
    return rank(a) - rank(b) || b.value - a.value;
  });
  return ranked.slice(0, 2).map((item) => `${item.label} ${item.value.toLocaleString('zh-CN')} 条`).join(' · ');
}

export function describeRunMode(run: WorkspaceConsoleRunDto): string {
  if(run.testResult)return 'JUnit 测试';
  if (!run.mode) return '未记录';
  return modeLabels[run.mode.toLowerCase()] ?? run.mode;
}

function runKind(run: WorkspaceConsoleRunDto): string {
  const name = [run.target, run.runId, run.mode].filter(Boolean).join(' ').toLowerCase();
  if (/(^|[^a-z])benchmark([^a-z]|$)/.test(name)) return '性能测试';
  if (/(^|[^a-z])(test|tests|suite)([^a-z]|$)/.test(name)) return '测试运行';
  if (/(^|[^a-z])(compile|build|maven)([^a-z]|$)/.test(name)) return '编译检查';
  if (/(^|[^a-z])(validator|validation|verify|check|postcheck)([^a-z]|$)/.test(name)) return '验证运行';
  if (/(^|[^a-z])(repair|fix)([^a-z]|$)/.test(name)) return '修复运行';
  return '运行记录';
}

function runTitle(run: WorkspaceConsoleRunDto): string {
  if (run.operation?.title) return run.operation.title;
  if (run.displayName?.trim()) return run.displayName.trim();
  if(run.testResult)return /(?:^|[-_])contract(?:[-_]|$)/i.test(run.runId)?'契约测试':'JUnit 测试';
  if (run.source === 'remote-runner' && remoteTargets[run.target ?? '']) return remoteTargets[run.target!];
  // A generic category loses the distinction between retries, probes and tests.
  return run.target && run.target !== run.taskId ? run.target : run.runId;
}

export function describeRunCategory(run: WorkspaceConsoleRunDto): '业务跑数' | '代码检查' | '执行记录' {
  if(run.testResult)return '代码检查';
  if (['性能测试', '测试运行', '编译检查', '验证运行'].includes(runKind(run))) return '代码检查';
  if (run.operation?.objects.length || run.resultMetrics?.items.length || run.businessResult?.object || run.insertedRows !== null || run.updatedRows !== null || remoteTargets[run.target ?? '']) return '业务跑数';
  return '执行记录';
}

export type RunFilter = 'all' | 'abnormal' | 'running';

export function runMatchesFilter(run: WorkspaceConsoleRunDto, filter: RunFilter): boolean {
  if (filter === 'all') return true;
  const status = run.status.toLowerCase();
  return filter === 'running' ? status === 'running'
    : ['failed', 'error', 'lost', 'stopped'].includes(status) || (run.testResult?.failures??0)>0 || ['failed', 'error'].includes(run.businessResult?.status?.toLowerCase() ?? '') || run.businessResult?.verified === false || run.businessResult?.preflightPassed === false;
}

export function describeRunAssociation(run:WorkspaceConsoleRunDto):string|null{
  return run.taskContext?.association==='unregistered'?'任务目录已识别 · 尚未登记台账'
    :run.taskContext?.association==='ambiguous'?'任务目录已识别 · 多份台账归属待核实':null;
}
export function describeTestResult(run:WorkspaceConsoleRunDto):string|null{
  const test=run.testResult;if(!test)return null;
  if(test.total===0)return '测试统计为 0 项，未证明验证通过';
  if(test.failures)return `共 ${test.total} 项测试 · 失败 ${test.failures} 项`;
  return run.exitCode===0&&['succeeded','success','done','completed'].includes(run.status.toLowerCase())?`${test.total} 项测试通过`:`日志记录 ${test.total} 项测试无失败，进程状态另见记录`;
}
export function describeTestErrors(run:WorkspaceConsoleRunDto):string|null{
  const names=run.testResult?.errorTypes;if(!names?.length)return null;
  return `异常类型：${names.map(name=>name==='NullPointerException'?'NullPointerException（空指针异常）':name).join('、')}`;
}

export function describeBusinessResult(run: WorkspaceConsoleRunDto): string[] {
  const result = run.businessResult;
  if (!result) return [];
  const facts: string[] = [];
  const reasons: Record<string, string> = { row_limit_reached: '达到本轮条数上限', completed: '处理结束', end_reached: '已到记录范围末尾', cancelled: '已取消', canceled: '已取消' };
  if (result.stopReason) facts.push(reasons[result.stopReason] ?? `停止原因：${result.stopReason}`);
  if (result.complete === false) facts.push('全量未完成');
  else if (result.complete === true) facts.push('记录范围已处理完成');
  if (['failed', 'error'].includes(result.status?.toLowerCase() ?? '')) facts.push('业务结果记录为失败');
  if (result.businessWrite === false) facts.push('记录注明未写入业务数据');
  else if (result.businessWrite === true) facts.push('业务写入模式');
  if (result.verified === true) facts.push('业务核验通过');
  else if (result.verified === false) facts.push('业务核验未通过');
  if (result.preflightPassed === true) facts.push('写入前预检通过');
  else if (result.preflightPassed === false) facts.push('写入前预检未通过');
  if (result.businessWrites != null) facts.push(`业务写入 ${result.businessWrites.toLocaleString('zh-CN')} 条`);
  if (result.formalSpWrites != null) facts.push(`正式 SP 写入 ${result.formalSpWrites.toLocaleString('zh-CN')} 条`);
  return facts;
}

export function describeRunProgress(run: WorkspaceConsoleRunDto): string[] {
  const result = run.businessResult;
  if (!result) return [];
  const facts: string[] = [];
  if (result.phase) facts.push(`阶段：${result.phase}`);
  if (result.rowsPerSecond !== null) facts.push(`记录速度 ${result.rowsPerSecond.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 条/秒`);
  if (result.rowLimit !== null) facts.push(`本轮上限 ${result.rowLimit.toLocaleString('zh-CN')} 条`);
  if (result.rowLimit !== null && result.limitPercent !== null) facts.push(`本轮限额进度 ${result.limitPercent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`);
  if (result.rowLimit !== null && result.etaSeconds !== null) facts.push(`记录预计距本轮上限 ${formatRunDuration(result.etaSeconds)}`);
  return facts;
}

export function describeRunScope(run: WorkspaceConsoleRunDto): string[] {
  const operation = run.operation;
  if (!operation) return run.businessResult?.object ? [`对象：${run.businessResult.object}`] : [];
  return [...operation.scope, ...(operation.plannedBusinessWrite===false ? ['计划：不写业务数据（执行结果另见下方）'] : []),
    ...(operation.source==='plan' ? ['ID 范围是扫描边界，不代表记录总数或完成比例'] : [])];
}

export function describeRun(run: WorkspaceConsoleRunDto): { title: string; outcome: string; detail: string | null } {
  const detail = run.summary?.trim() && run.summary !== '暂无结果摘要' ? run.summary.trim() : null;
  const rawStatus = run.status?.trim();
  const status = outcomes[rawStatus?.toLowerCase()] ?? (rawStatus && rawStatus.toLowerCase() !== 'unknown' ? rawStatus : null);
  const hasResult = run.exitCode !== null || run.committed !== null || run.insertedRows !== null || run.updatedRows !== null || run.finishedAt !== null;
  const onlyDirectory = !hasResult && !detail && run.evidenceFiles.length === 0 && !run.mode && !run.target && !run.startedAt;
  return {
    title: runTitle(run),
    outcome: run.testResult&&run.status.toLowerCase()!=='running'&&run.testResult.failures>0?'测试失败'
      :run.testResult&&run.exitCode===0&&['succeeded','success','done','completed'].includes(run.status.toLowerCase())?run.testResult.total>0?'测试通过':'未执行测试'
      :status ?? (onlyDirectory ? '仅发现目录，暂无运行结果' : hasResult ? '最终状态未记录' : '结果未记录'),
    detail,
  };
}

export function describeRunResult(run: WorkspaceConsoleRunDto): { outcome: string; facts: string[] } {
  const { outcome } = describeRun(run);
  const facts: string[] = describeBusinessResult(run);
  const tests=describeTestResult(run),errors=describeTestErrors(run);
  if(tests)facts.push(tests);
  if(errors)facts.push(errors);
  if (run.failureReason) facts.push(run.failureReason);
  if (!run.resultMetrics?.items.length && (run.updatedRows !== null || run.insertedRows !== null)) {
    const changes = [run.updatedRows !== null ? `更新 ${run.updatedRows.toLocaleString('zh-CN')} 行` : null, run.insertedRows !== null ? `新增 ${run.insertedRows.toLocaleString('zh-CN')} 行` : null].filter(Boolean);
    facts.push(changes.join('，'));
  }
  if (run.committed === true) facts.push('变更已提交');
  else if (run.committed === false) facts.push('变更未提交');
  if (run.verification && (run.verification.rowCount !== null || run.verification.invalidDataStatusCount !== null)) {
    const checks = [run.verification.rowCount !== null ? `核验 ${run.verification.rowCount.toLocaleString('zh-CN')} 行` : null, run.verification.invalidDataStatusCount !== null ? `异常状态 ${run.verification.invalidDataStatusCount.toLocaleString('zh-CN')} 行` : null].filter(Boolean);
    facts.push(checks.join('，'));
  }
  if (!facts.length) facts.push(outcome === '记录为运行中' ? '运行状态以最近观测为准；所示结果来自本机已有文件'
    : outcome === '进程正常结束' ? '业务完成情况未记录'
    : outcome === '仅发现目录，暂无运行结果' ? '未记录执行过程和结果'
    : outcome === '执行失败' ? '失败原因未记录'
    : '未记录更具体的业务结果');
  return { outcome, facts };
}
