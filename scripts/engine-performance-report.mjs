import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const PREFIX = '[Relay:EnginePerformance] ';
const ENGINES = ['codex', 'codebuddy'];
const OUTCOMES = ['completed', 'failed', 'interrupted', 'closed'];
const METRICS = [
  'connectionMs', 'initializeMs', 'configurationMs', 'sessionReadyMs', 'requestSendMs',
  'turnStartMs', 'firstOutputMs', 'terminalMs', 'totalMs',
];
const BASE_FIELDS = ['engine', 'existingSession', 'connectionReused', 'recovery', 'outcome'];

export function parsePerformanceLines(lines) {
  const records = [];
  for (const line of lines) {
    const index = line.indexOf(PREFIX);
    if (index < 0) continue;
    try {
      const source = JSON.parse(line.slice(index + PREFIX.length));
      if (!source || typeof source !== 'object' || !ENGINES.includes(source.engine)
        || !OUTCOMES.includes(source.outcome) || typeof source.existingSession !== 'boolean'
        || typeof source.connectionReused !== 'boolean' || typeof source.recovery !== 'boolean') continue;
      const record = {};
      for (const field of BASE_FIELDS) record[field] = source[field];
      for (const field of METRICS) {
        if (Number.isFinite(source[field]) && source[field] >= 0) record[field] = source[field];
      }
      records.push(record);
    } catch {
      // 组合日志可能包含截断或损坏行，报表跳过而不是失败。
    }
  }
  return records;
}

export function summarizePerformanceRecords(records) {
  return ENGINES.flatMap((engine) => {
    const group = records.filter((record) => record.engine === engine);
    if (group.length === 0) return [];
    const successCount = group.filter((record) => record.outcome === 'completed').length;
    const decisionRecords = group.filter((record) => record.existingSession && !record.connectionReused
      && !record.recovery && record.outcome === 'completed');
    return [{
      engine, count: group.length, successCount, successRate: round(successCount / group.length * 100),
      decisionSamples: decisionRecords.length,
      newSessions: group.filter((record) => !record.existingSession).length,
      recoverySamples: group.filter((record) => record.recovery).length,
      reusedConnections: group.filter((record) => record.connectionReused).length,
      metrics: summarizeMetrics(decisionRecords),
    }];
  });
}

export async function loadPerformanceRecords(logsDirectory) {
  let names;
  try {
    names = await readdir(logsDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = names.filter((name) => /^relay-.*\.log$/u.test(name)).sort();
  const records = [];
  for (const name of files) {
    const reader = createInterface({ input: createReadStream(path.join(logsDirectory, name), { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of reader) records.push(...parsePerformanceLines([line]));
  }
  return records;
}

export function formatPerformanceReport(summaries) {
  if (summaries.length === 0) return '尚未找到引擎性能观测样本。';
  const sections = ['引擎性能观测（毫秒）'];
  for (const summary of summaries) {
    sections.push('', `${summary.engine}: 全部 ${summary.count}，成功 ${summary.successCount}（${summary.successRate}%）`);
    sections.push(`  决策样本 ${summary.decisionSamples}（成功 + 既有会话 + 冷连接 + 非恢复）`);
    sections.push(`  非决策标签（可重叠）：新会话 ${summary.newSessions}，连接复用 ${summary.reusedConnections}，重启恢复 ${summary.recoverySamples}`);
    for (const [name, metric] of Object.entries(summary.metrics)) {
      sections.push(`  ${name}: n=${metric.count} p50=${metric.p50} p95=${metric.p95} max=${metric.max}`);
    }
  }
  return sections.join('\n');
}

function percentile(values, fraction) {
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

function summarizeMetrics(records) {
  const metrics = {};
  for (const field of METRICS) {
    const values = records.map((record) => record[field]).filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length > 0) metrics[field] = { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.at(-1) };
  }
  return metrics;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function main() {
  const logsDirectory = path.resolve(process.cwd(), 'logs');
  const records = await loadPerformanceRecords(logsDirectory);
  console.log(formatPerformanceReport(summarizePerformanceRecords(records)));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`生成引擎性能报表失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
