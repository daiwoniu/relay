import process from 'node:process';
import { commandNames, formatCommandHelp, formatProjectHelp, hasHelpArgument, printHelp } from './lib/help.mjs';

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && hasHelpArgument(args))) {
  printHelp(formatProjectHelp());
} else if (args.length === 1 && commandNames().includes(args[0])) {
  printHelp(formatCommandHelp(args[0]));
} else {
  console.error(`未知帮助主题：${args.join(' ')}`);
  console.error(`可用主题：${commandNames().join('、')}`);
  console.error();
  process.exitCode = 1;
}
