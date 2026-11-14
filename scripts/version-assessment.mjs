import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { collectVersionAssessment, formatVersionAssessment } from './lib/version-assessment.mjs';
import { formatCommandHelp, hasHelpArgument, printHelp } from './lib/help.mjs';

const args = process.argv.slice(2);
if (hasHelpArgument(args)) {
  printHelp(formatCommandHelp('version:assess'));
} else if (args.some((arg) => arg !== '--json')) {
  console.error(`未知参数：${args.filter((arg) => arg !== '--json').join(' ')}`);
  console.error('运行 npm run version:assess help 查看支持的参数。');
  process.exitCode = 1;
} else {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = collectVersionAssessment(root);
    console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : formatVersionAssessment(result));
  } catch (error) {
    console.error(`版本评估证据生成失败：${error.message}`);
    process.exitCode = 1;
  }
}
