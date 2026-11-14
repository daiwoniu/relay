import fs from 'node:fs';
import path from 'node:path';
import { ACCEPTANCE_ROOT } from './run-state.mjs';
import { redactReportValue } from './redaction.mjs';

export const SCENARIO_STATUSES = new Set(['passed', 'failed', 'inconclusive', 'manual_required']);

export function createScenarioResult(input) {
  if (!input || typeof input.id !== 'string' || !input.id) throw new Error('场景 ID 无效');
  if (!SCENARIO_STATUSES.has(input.status)) throw new Error('场景状态无效');
  return redactReportValue({ ...input });
}

export function aggregateScenarioStatus(scenarios) {
  const statuses = scenarios.map((item) => item.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('inconclusive')) return 'inconclusive';
  if (statuses.includes('manual_required')) return 'manual_required';
  return statuses.length > 0 && statuses.every((status) => status === 'passed') ? 'passed' : 'inconclusive';
}

export function aggregateReportStatus(scenarios, cleanup) {
  const scenarioStatus = aggregateScenarioStatus(scenarios);
  if (scenarioStatus !== 'passed') return scenarioStatus;
  if (cleanup && (cleanup.process !== 'cleaned' || cleanup.port !== 'released' || cleanup.profile !== 'removed')) return 'failed';
  return scenarioStatus;
}

export function writeAcceptanceReport({ runDir, report, acceptanceRoot = ACCEPTANCE_ROOT }) {
  const root = path.resolve(acceptanceRoot);
  const resolvedRunDir = path.resolve(runDir);
  if (path.dirname(resolvedRunDir) !== root) throw new Error('报告目录越界');
  fs.mkdirSync(resolvedRunDir, { recursive: true });
  const scenarios = (report.scenarios || []).map(createScenarioResult);
  const safeReport = redactReportValue({ ...report, status: aggregateReportStatus(scenarios, report.cleanup), scenarios });
  const jsonPath = path.join(resolvedRunDir, 'report.json');
  const summaryPath = path.join(resolvedRunDir, 'summary.md');
  writeAtomic(jsonPath, `${JSON.stringify(safeReport, null, 2)}\n`);
  writeAtomic(summaryPath, renderSummary(safeReport));
  return { jsonPath, summaryPath, report: safeReport };
}

function renderSummary(report) {
  const lines = [`# Relay Headless 验收摘要`, '', `- Run: ${report.runId || 'unknown'}`, `- 状态: ${report.status}`, ''];
  for (const scenario of report.scenarios || []) lines.push(`- ${scenario.id}: ${scenario.status}${scenario.detail ? ` — ${scenario.detail}` : ''}`);
  if (report.cleanup) lines.push('', `- 清理: process=${report.cleanup.process}, port=${report.cleanup.port}, profile=${report.cleanup.profile}`);
  return `${lines.join('\n')}\n`;
}

function writeAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(temporary, filePath); } finally { fs.rmSync(temporary, { force: true }); }
}
