import path from 'node:path';
import { cleanupEdgeRuntime, launchEdge } from './edge-runtime.mjs';
import { connectPageRuntime } from './page-session.mjs';
import { aggregateReportStatus, createScenarioResult, writeAcceptanceReport } from './report.mjs';
import { finalizeRunState } from './run-state.mjs';

export async function runReadOnlyAcceptance({
  config, cookieValue,
  launchRuntime = (options) => launchEdge(options),
  connectPage = (runtime) => connectPageRuntime(runtime),
  cleanupRuntime = (options) => cleanupEdgeRuntime(options),
  finalizeState = (runtime, cleanup) => finalizeRunState(runtime, cleanup),
  writeReport = (options) => writeAcceptanceReport(options),
  runAdditionalScenarios,
}) {
  let runtime;
  let browserCdp;
  let caught;
  const scenarios = [];
  let cleanup;
  try {
    runtime = await launchRuntime({ edgePath: config.edgePath, origin: config.origin, timeoutMs: config.timeouts?.startupMs });
    const connected = await connectPage(runtime);
    browserCdp = connected.browserCdp;
    const page = connected.page;
    await page.enableMonitoring();
    await page.injectRelaySession({ origin: config.origin, cookieValue });
    await page.navigate(config.origin);
    for (const item of [
      { id: 'desktop', viewport: config.desktopViewport, mobile: false },
      { id: 'mobile', viewport: config.mobileViewport, mobile: true },
    ]) scenarios.push(await runViewportScenario({ page, runtime, config, ...item }));
    if (runAdditionalScenarios) {
      // The last read-only viewport is mobile, whose sidebar is closed by default.
      await page.setViewport(config.desktopViewport, { mobile: false });
      await page.waitForStable({ timeoutMs: config.timeouts?.navigationMs, requireMetadata: true });
      scenarios.push(...await runAdditionalScenarios({ page, runtime }));
    }
  } catch (error) {
    caught = error;
    scenarios.push(createScenarioResult({ id: 'orchestration', status: 'failed', detail: error instanceof Error ? error.message : '页面验收失败' }));
  } finally {
    if (runtime) {
      cleanup = await cleanupRuntime({ runtime, cdp: browserCdp }).catch(() => ({ process: 'remaining', port: 'listening', profile: 'remaining' }));
      try {
        await finalizeState(runtime, cleanup);
      } catch (error) {
        if (!caught) caught = error;
      }
    }
  }
  const report = {
    runId: runtime?.runId || 'not-started',
    generatedAt: new Date().toISOString(),
    mode: 'read-only',
    scenarios,
    cleanup,
  };
  report.status = aggregateReportStatus(scenarios, cleanup);
  if (runtime?.runDir) writeReport({ runDir: runtime.runDir, report });
  if (caught) throw caught;
  return report;
}

async function runViewportScenario({ id, viewport, mobile, page, runtime, config }) {
  await page.setViewport(viewport, { mobile });
  const before = await page.waitForStable({ timeoutMs: config.timeouts?.navigationMs, requireMetadata: true });
  const screenshotDir = path.join(runtime.runDir, 'screenshots');
  await page.captureScreenshot(path.join(screenshotDir, `${id}-initial.png`));
  await page.reload({ timeoutMs: config.timeouts?.navigationMs });
  const after = await page.waitForStable({ timeoutMs: config.timeouts?.navigationMs, requireMetadata: true });
  await page.captureScreenshot(path.join(screenshotDir, `${id}-refreshed.png`));
  const stable = summariesEqual(before, after);
  const evidence = page.getEvidence();
  const metadataComplete = Number.isInteger(after.protocolVersion) && typeof after.buildId === 'string' && /^[a-f0-9]{8,16}$/u.test(after.buildId);
  const hasBlockingError = evidence.exceptions.length > 0
    || evidence.logErrors.some((item) => item.level === 'error')
    || evidence.httpErrors.length > 0
    || evidence.webSockets.reconnects > 3;
  return createScenarioResult({
    id,
    status: !stable || !metadataComplete || hasBlockingError ? 'failed' : 'passed',
    detail: !stable ? '刷新前后会话摘要不一致'
      : !metadataComplete ? '未读取到 production Build ID 或 Relay 协议版本'
        : (mobile ? '移动视口模拟通过；仍需真机触摸验收' : '桌面视口与刷新恢复稳定'),
    viewport,
    snapshot: { authenticated: after.authenticated, buildId: after.buildId, protocolVersion: after.protocolVersion, sessionCount: after.sessions?.length || 0 },
    evidence,
    screenshots: [`screenshots/${id}-initial.png`, `screenshots/${id}-refreshed.png`],
  });
}

function summariesEqual(left, right) {
  return left?.authenticated === true && right?.authenticated === true
    && JSON.stringify([...(left.sessions || [])].sort()) === JSON.stringify([...(right.sessions || [])].sort())
    && left.currentSession === right.currentSession;
}
