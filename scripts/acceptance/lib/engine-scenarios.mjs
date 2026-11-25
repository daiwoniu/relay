import { randomBytes } from 'node:crypto';
import { createScenarioResult } from './report.mjs';

const ENGINES = new Set(['codex', 'codebuddy', 'all']);
const SCENARIOS = new Set(['complete', 'stop', 'refresh']);
const INCONCLUSIVE_CODES = new Set(['provider_unavailable', 'restart_required', 'process_crash']);
const PROMPTS = {
  complete: { id: 'fixed-short-complete-v1', body: '请只回复：HEADLESS_ACCEPTANCE_OK' },
  stop: { id: 'fixed-short-stop-v1', body: '请从 1 开始逐行计数到 200，每行一个数字。' },
  refresh: { id: 'fixed-short-refresh-v1', body: '请分三段简短说明页面刷新后的会话恢复检查。' },
};

export function parseAcceptanceArguments(args) {
  if (!Array.isArray(args)) throw new Error('参数无效');
  if (args.length === 0) return { mode: 'read-only' };
  if (args.length === 1 && args[0] === '--workbench') return { mode: 'read-only', workbench: true };
  if (args.length === 1 && args[0] === '--account-settings') return { mode: 'read-only', accountSettings: true };
  if (args.length === 1 && args[0] === '--feishu-approvals') return { mode: 'read-only', feishuApprovals: true };
  if (args.length === 1 && args[0] === '--feishu-approvals-built') return { mode: 'read-only', feishuApprovals: true, built: true };
  const values = new Map();
  let allowed = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--allow-engine-run') { if (allowed) throw new Error('参数重复：--allow-engine-run'); allowed = true; continue; }
    if (arg === '--engine' || arg === '--scenario') {
      if (values.has(arg)) throw new Error(`参数重复：${arg}`);
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
      values.set(arg, value); index += 1; continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (!allowed || !values.has('--engine') || !values.has('--scenario')) throw new Error('真实引擎必须同时明确 --allow-engine-run、--engine 和 --scenario');
  const engine = values.get('--engine');
  const scenario = values.get('--scenario');
  if (!ENGINES.has(engine)) throw new Error('engine 必须是 codex、codebuddy 或 all');
  if (!SCENARIOS.has(scenario)) throw new Error('scenario 必须是 complete、stop 或 refresh');
  return { mode: 'engine', engine, scenario };
}

export async function runEngineScenarios({ page, engine, scenario, now = Date.now }) {
  if (!ENGINES.has(engine) || engine === undefined || !SCENARIOS.has(scenario)) throw new Error('真实引擎场景参数无效');
  const engines = engine === 'all' ? ['codex', 'codebuddy'] : [engine];
  const results = [];
  for (const engineId of engines) results.push(await runOne({ page, engine: engineId, scenario, now }));
  return results;
}

async function runOne({ page, engine, scenario, now }) {
  const attempt = `${now()}-${randomBytes(4).toString('hex')}`;
  const prompt = PROMPTS[scenario];
  const title = `[HEADLESS-ACCEPTANCE] ${engine} ${scenario} ${attempt}`;
  try {
    const session = await page.createAcceptanceSession({ title, engine });
    await page.openSession({ sessionId: session.id, title });
    await page.assertEngineSelected(engine);
    await page.sendPrompt(prompt.body);
    if (scenario === 'stop' || scenario === 'refresh') await page.waitForProcessing();
    if (scenario === 'stop') await page.stopGeneration();
    if (scenario === 'refresh') { await page.reload(); await page.waitForStable(); }
    const terminal = await page.waitForTerminal(session.id);
    if (terminal.outcome === 'failed' && isEnvironmentalFailure(terminal.errorCode)) {
      return createScenarioResult({
        id: `engine-${engine}-${scenario}`, status: 'inconclusive', engine, scenario, attempt,
        promptId: prompt.id, sessionId: session.id, errorCode: terminal.errorCode,
        detail: 'Provider、引擎进程或正式服务状态导致结论不确定', terminal,
      });
    }
    const expectedOutcome = scenario === 'stop' ? 'stopped' : 'completed';
    const unique = terminal.userCount === 1 && terminal.assistantCount === 1 && terminal.terminalCount === 1;
    const passed = unique && terminal.outcome === expectedOutcome;
    return createScenarioResult({
      id: `engine-${engine}-${scenario}`, status: passed ? 'passed' : 'failed', engine, scenario, attempt,
      promptId: prompt.id, sessionId: session.id,
      detail: passed ? `${engine} ${scenario} 唯一终态通过` : `${engine} ${scenario} 消息数量或终态不符合预期`,
      terminal,
    });
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : null;
    return createScenarioResult({
      id: `engine-${engine}-${scenario}`,
      status: INCONCLUSIVE_CODES.has(code) ? 'inconclusive' : 'failed',
      engine, scenario, attempt, promptId: prompt.id, errorCode: code,
      detail: INCONCLUSIVE_CODES.has(code) ? 'Provider、进程或正式服务状态无法安全注入，结论不确定' : (error instanceof Error ? error.message : '真实引擎场景失败'),
    });
  }
}

function isEnvironmentalFailure(code) {
  return typeof code === 'string' && /(?:PROVIDER|AUTH_REQUIRED|PROCESS_|ENGINE_UNAVAILABLE|MAINTENANCE|SERVICE_RECOVERY|RESTART_RECOVERY|CONNECT|CONNECTION)/u.test(code);
}
