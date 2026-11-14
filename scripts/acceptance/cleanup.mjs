import process from 'node:process';
import { connectCdpClient } from './lib/cdp-client.mjs';
import { cleanupEdgeRuntime } from './lib/edge-runtime.mjs';
import { finalizeRunState, readRunState } from './lib/run-state.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
  console.log('用法：npm run acceptance:cleanup -- --run-id <runId>\n\n只清理指定 run ID 的 Edge、调试端口和临时 profile；不会按进程名批量终止。');
} else {
  const runId = parseRunId(args);
  if (!runId) {
    console.error('必须且只能提供 --run-id <runId>。');
    process.exitCode = 1;
  } else {
    try {
      const state = readRunState(runId);
      const cdp = state.webSocketUrl ? await connectCdpClient(state.webSocketUrl, { timeoutMs: 2000, expectedPort: state.port }).catch(() => null) : null;
      const result = await cleanupEdgeRuntime({ runtime: state, cdp });
      finalizeRunState(state, result);
      console.log(`${runId}: 进程 ${result.process}；端口 ${result.port}；profile ${result.profile}`);
      if (Object.values(result).some((value) => ['remaining', 'listening'].includes(value))) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : '清理失败');
      process.exitCode = 1;
    }
  }
}

function parseRunId(values) {
  return values.length === 2 && values[0] === '--run-id' ? values[1] : null;
}
