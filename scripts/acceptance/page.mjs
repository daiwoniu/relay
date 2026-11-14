import fs from 'node:fs';
import process from 'node:process';
import { loadAndVerifySession } from './lib/auth-session.mjs';
import { loadAcceptanceConfig } from './lib/config.mjs';
import { runDpapi } from './lib/dpapi.mjs';
import { createRunPaths } from './lib/run-state.mjs';
import { runReadOnlyAcceptance } from './lib/read-only-scenarios.mjs';
import { writeAcceptanceReport } from './lib/report.mjs';
import { SESSION_PATH } from './lib/paths.mjs';
import { parseAcceptanceArguments, runEngineScenarios } from './lib/engine-scenarios.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) printHelp();
else await main(args);

async function main(rawArgs) {
  try {
    const options = parseAcceptanceArguments(rawArgs);
    const config = loadAcceptanceConfig();
    if (!await relayAvailable(config.origin)) {
      const paths = createRunPaths();
      fs.mkdirSync(paths.runDir, { recursive: true });
      const result = writeAcceptanceReport({ runDir: paths.runDir, report: { runId: paths.runId, generatedAt: new Date().toISOString(), mode: 'read-only', scenarios: [{ id: 'service', status: 'inconclusive', detail: 'Relay production 服务不可用；未启动 Edge' }] } });
      console.log(`验收结论：inconclusive\n报告：${result.summaryPath}`);
      process.exitCode = 2;
      return;
    }
    const session = await loadAndVerifySession({
      config,
      readSession: async () => fs.readFileSync(SESSION_PATH, 'utf8').trim(),
      unprotect: (value) => runDpapi('unprotect', value),
    });
    if (options.mode === 'engine') console.log(`真实引擎场景：engine=${options.engine}, scenario=${options.scenario}`);
    const report = await runReadOnlyAcceptance({
      config,
      cookieValue: session.cookieValue,
      runAdditionalScenarios: options.mode === 'engine'
        ? ({ page }) => runEngineScenarios({ page, engine: options.engine, scenario: options.scenario })
        : undefined,
    });
    console.log(`验收结论：${report.status}`);
    console.log(`运行目录：.relay-dev/acceptance/${report.runId}`);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : '页面验收失败');
    process.exitCode = 1;
  }
}

async function relayAvailable(origin) {
  try { const response = await fetch(`${origin}/__relay/frontend-status`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); return response.ok; } catch { return false; }
}

function printHelp() {
  console.log(`Relay Headless 页面验收\n\n用法：\n  npm run acceptance:page\n  npm run acceptance:page -- --allow-engine-run --engine <codex|codebuddy|all> --scenario <complete|stop|refresh>\n\n说明：\n  默认只读；不会创建会话、发送消息、停止任务或重启 Relay。\n  真实引擎必须同时显式提供 allow、engine、scenario，且不会自动重启服务或注入 Provider 故障。\n  使用独立 Edge profile，完成报告、截图和精确清理。`);
}
