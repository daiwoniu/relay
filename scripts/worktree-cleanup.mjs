import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cleanWorktree, listProjectWorktrees } from './lib/worktree-cleanup.mjs';
import { formatCommandHelp, hasHelpArgument, printHelp } from './lib/help.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

if (hasHelpArgument(args)) {
  printHelp(formatCommandHelp('worktree:clean'));
} else if (args.length === 1 && args[0] === '--check') {
  const worktrees = listProjectWorktrees(ROOT);
  console.log(`项目临时 worktree：${worktrees.length} 个`);
  for (const entry of worktrees) {
    const branch = typeof entry.branch === 'string' ? entry.branch.replace('refs/heads/', '') : '未关联分支';
    console.log(`- ${entry.worktree} | ${branch}`);
  }
  console.log();
} else if (args.length === 1) {
  try {
    const result = cleanWorktree(ROOT, args[0]);
    console.log(`已清理临时 worktree：${result.target}`);
    console.log(`已删除合并分支：${result.branch}`);
    console.log();
  } catch (error) {
    console.error(`清理失败：${error instanceof Error ? error.message : String(error)}`);
    console.error();
    process.exitCode = 1;
  }
} else {
  console.error('请提供一个 worktree 名称，或使用 --check。');
  console.error('运行 npm run worktree:clean help 查看用法。');
  console.error();
  process.exitCode = 1;
}
