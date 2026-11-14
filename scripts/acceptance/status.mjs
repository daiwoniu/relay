import process from 'node:process';
import { listRunStates } from './lib/run-state.mjs';
import { queryOwnedProcesses } from './lib/process-control.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
  console.log('用法：npm run acceptance:status\n\n只读列出页面验收运行目录、状态和精确匹配的 Edge PID；不会启动或终止进程。');
} else if (args.length > 0) {
  console.error(`未知参数：${args.join(' ')}`);
  process.exitCode = 1;
} else {
  const states = listRunStates();
  if (states.length === 0) {
    console.log('页面验收状态：没有运行记录或遗留资源。');
  } else {
    for (const state of states) {
      let processStatus = '无';
      if (state.profileDir) {
        try {
          const pids = await queryOwnedProcesses(state.profileDir);
          processStatus = pids.length ? pids.join(', ') : '无';
        } catch {
          processStatus = '查询失败';
          process.exitCode = 1;
        }
      }
      console.log(`${state.runId}: ${state.status || 'unknown'}; Edge PID: ${processStatus}`);
    }
  }
}
