import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBuildBudget, createBudgetBaseline, evaluateBuildBudget, DEFAULT_BUILD_BUDGET } from './build-budget.mjs';
export { collectBuildBudget, createBudgetBaseline, evaluateBuildBudget, DEFAULT_BUILD_BUDGET } from './build-budget.mjs';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultBaseline = path.join(clientRoot, 'scripts', 'build-budget-baseline.json');
const kib = value => `${(value / 1024).toFixed(2)} KiB`;

export function runBuildBudget(args = process.argv.slice(2), output = console) {
  let distDir = path.join(clientRoot, 'dist'), baselinePath = defaultBaseline, json = false, writeBaseline = false, commit;
  let positional = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') {
      output.log('用法：node client/scripts/check-build-budget.mjs [产物目录] [--json] [--baseline 文件]');
      output.log('人工更新已验收基线：追加 --write-baseline --source-commit <40位提交号>；普通构建绝不更新基线。');
      return { ok: true };
    }
    if (arg === '--json') json = true;
    else if (arg === '--write-baseline') writeBaseline = true;
    else if (arg === '--baseline' || arg === '--source-commit') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg}缺少参数`);
      if (arg === '--baseline') baselinePath = path.resolve(value); else commit = value;
    } else if (!arg.startsWith('-') && !positional) { distDir = path.resolve(arg); positional = true; }
    else throw new Error(`未知参数：${arg}`);
  }
  if (commit && !writeBaseline) throw new Error('--source-commit只能用于显式更新基线');
  const report = collectBuildBudget(distDir);
  if (writeBaseline) {
    const version = JSON.parse(fs.readFileSync(path.join(clientRoot, '..', 'package.json'), 'utf8')).version;
    const baseline = createBudgetBaseline(report, { commit, version });
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    output.log(json ? JSON.stringify({ ok: true, baseline }) : `已人工记录固定基线：${version} · ${commit}`);
    return { ok: true, baseline };
  }
  if (!fs.existsSync(baselinePath)) throw new Error('缺少已验收的体积基线；需显式记录，不能随构建自动生成');
  if (fs.statSync(baselinePath).size > 256 * 1024) throw new Error('体积基线文件异常过大');
  const result = evaluateBuildBudget(report, JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
  if (json) output.log(JSON.stringify(result));
  else {
    output.log(`前端体积检查：${result.severity === 'error' ? '阻断' : result.severity === 'warning' ? '通过（有告警）' : '通过'}；基线 ${result.baselineSource.version} · ${result.baselineSource.commit.slice(0, 8)}`);
    output.log(`全部JS ${kib(report.totals.jsBytes)}；全部CSS ${kib(report.totals.cssBytes)}；JS gzip估算 ${kib(report.totals.jsGzipBytes)}；CSS gzip估算 ${kib(report.totals.cssGzipBytes)}`);
    output.log('入口统计仅含静态依赖，按文件去重；gzip是估算，不代表未开启压缩时的实际传输量。');
    output.log(`增长检测线（JS+CSS原始体积，绝对与相对须同时超过）：告警 ${kib(DEFAULT_BUILD_BUDGET.warningGrowth.bytes)} / ${DEFAULT_BUILD_BUDGET.warningGrowth.ratio * 100}%；阻断 ${kib(DEFAULT_BUILD_BUDGET.errorGrowth.bytes)} / ${DEFAULT_BUILD_BUDGET.errorGrowth.ratio * 100}%；不是加载时长承诺。`);
    for (const [id, entry] of Object.entries(result.routes)) {
      output.log(`- ${id}: JS ${kib(entry.jsBytes)} + CSS ${kib(entry.cssBytes)}；相对基线 ${entry.deltaBytes >= 0 ? '+' : ''}${kib(entry.deltaBytes)}${entry.growthRatio === null ? '' : ` (${(entry.growthRatio * 100).toFixed(1)}%)`} [${entry.severity}]`);
    }
    output.log(`离线脚本 ${kib(report.totals.offlineScriptBytes)}；最大JS分包 ${report.chunks[0] ? `${report.chunks[0].name} ${kib(report.chunks[0].bytes)}` : '无'}`);
    for (const warning of result.warnings) output.log(`[告警] ${warning.message}`);
    for (const error of result.errors) output.error(`[阻断] ${error.message}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!runBuildBudget().ok) process.exitCode = 1; }
  catch (error) {
    const message = error instanceof Error ? error.message : '体积检查失败';
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, severity: 'error', errors: [{ code: 'INVALID_BUILD_OR_BASELINE', message }] }));
    else console.error(`前端体积检查失败：${message}`);
    process.exitCode = 1;
  }
}
