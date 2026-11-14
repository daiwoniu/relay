import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatCommandHelp, hasHelpArgument, printHelp } from './lib/help.mjs';
import { discoverScriptTests } from './lib/test-discovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

if (hasHelpArgument(args)) {
  printHelp(formatCommandHelp('test:scripts'));
} else if (args.length > 0) {
  console.error(`未知参数：${args.join(' ')}`);
  console.error('运行 npm run test:scripts help 查看支持的参数。');
  console.error();
  process.exitCode = 1;
} else {
  const tests = discoverScriptTests(ROOT);
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`无法运行根脚本测试：${result.error.message}`);
    console.error();
    process.exitCode = 1;
  } else {
    console.log();
    process.exitCode = result.status ?? 1;
  }
}
