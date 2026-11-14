import type { WorkspaceConsoleRunDto } from '../../generated/relay-contracts';

const outcomes: Record<string, string> = {
  succeeded: '成功', success: '成功', done: '完成', completed: '完成',
  failed: '失败', error: '失败', running: '进行中', pending: '待运行',
  cancelled: '已取消', canceled: '已取消',
};

const remoteTargets: Record<string, string> = {
  'tanji-executed-history-sample': '历史被执行人样本导出',
  'tanji-executed-mapping-canary': '旧 ID 映射核查',
  'tanji-executed-mapping-full': '旧 ID 映射全量处理',
};

const modeLabels: Record<string, string> = {
  'dry-run': '预演（不写入）', execute: '执行', sample: '样本', repair: '修复', test: '测试',
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
  if (!items?.length) return null;
  const preferred = run.mode?.toLowerCase() === 'dry-run'
    ? ['已扫描', '计划修复', '已导出', '探查取得', '已更新', '已插入']
    : ['已更新', '已插入', '已导出', '已扫描', '计划修复', '探查取得'];
  const ranked = [...items].sort((a, b) => {
    const rank = (item: typeof a) => (item.kind === 'condition' ? 200 : (preferred.indexOf(item.label) < 0 ? 50 : preferred.indexOf(item.label))) + (item.value === 0 ? 100 : 0);
    return rank(a) - rank(b) || b.value - a.value;
  });
  return ranked.slice(0, 2).map((item) => `${item.label} ${item.value.toLocaleString('zh-CN')} 条`).join(' · ');
}

export function describeRunMode(run: WorkspaceConsoleRunDto): string {
  if (!run.mode) return '未记录';
  return modeLabels[run.mode.toLowerCase()] ?? '其他模式';
}

function runTitle(run: WorkspaceConsoleRunDto): string {
  if (run.source === 'remote-runner') return remoteTargets[run.target ?? ''] ?? '远程跑数任务';
  const name = [run.target, run.runId, run.mode].filter(Boolean).join(' ').toLowerCase();
  if (/(^|[^a-z])benchmark([^a-z]|$)/.test(name)) return '性能测试';
  if (/(^|[^a-z])(test|tests|suite)([^a-z]|$)/.test(name)) return '测试运行';
  if (/(^|[^a-z])(compile|build|maven)([^a-z]|$)/.test(name)) return '编译检查';
  if (/(^|[^a-z])(validator|validation|verify|check|postcheck)([^a-z]|$)/.test(name)) return '验证运行';
  if (/(^|[^a-z])(repair|fix)([^a-z]|$)/.test(name)) return '修复运行';
  return '运行记录';
}

export function describeRunCategory(run: WorkspaceConsoleRunDto): '业务跑数' | '代码检查' | '执行记录' {
  if (run.source === 'remote-runner' || run.resultMetrics?.items.length || run.insertedRows !== null || run.updatedRows !== null) return '业务跑数';
  return ['性能测试', '测试运行', '编译检查', '验证运行'].includes(runTitle(run)) ? '代码检查' : '执行记录';
}

export function describeRun(run: WorkspaceConsoleRunDto): { title: string; outcome: string; detail: string | null } {
  const detail = run.summary?.trim() && run.summary !== '暂无结果摘要' ? run.summary.trim() : null;
  const rawStatus = run.status?.trim();
  const status = outcomes[rawStatus?.toLowerCase()] ?? (rawStatus && rawStatus.toLowerCase() !== 'unknown' ? rawStatus : null);
  const hasResult = run.exitCode !== null || run.committed !== null || run.insertedRows !== null || run.updatedRows !== null || run.finishedAt !== null;
  const onlyDirectory = !hasResult && !detail && run.evidenceFiles.length === 0 && !run.mode && !run.target && !run.startedAt;
  return {
    title: runTitle(run),
    outcome: status ?? (onlyDirectory ? '仅发现目录，暂无运行结果' : hasResult ? '最终状态未记录' : '结果未记录'),
    detail,
  };
}

export function describeRunResult(run: WorkspaceConsoleRunDto): { outcome: string; facts: string[] } {
  const { title, outcome } = describeRun(run);
  const facts: string[] = [];
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
  if (!facts.length) facts.push(run.source === 'remote-runner' && outcome === '进行中' ? run.resultMetrics?.items.length ? '登记状态为进行中；所示计数来自本机已收集进度，是否仍在运行以最近核查为准' : '登记状态为进行中；本机尚未收集执行进度，是否仍在运行以最近核查为准'
    : run.source === 'remote-runner' && outcome === '成功' ? 'Runner 登记为成功；业务结果以所属任务的验收记录为准'
    : outcome === '仅发现目录，暂无运行结果' ? '未记录执行过程和结果'
    : outcome === '失败' ? '失败原因未记录'
    : title === '测试运行' ? '未记录具体的测试通过数或业务结果' : '未记录更具体的业务结果');
  return { outcome, facts };
}
