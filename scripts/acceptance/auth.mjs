import process from 'node:process';
import readline from 'node:readline';
import {
  assertSafeConfigPath,
  isGitTracked,
  loadAcceptanceAuthConfig,
  validateAcceptanceConfig,
  writeAcceptanceConfig,
  writePrivateFile,
} from './lib/config.mjs';
import { loginAndStoreSession } from './lib/auth-session.mjs';
import { runDpapi } from './lib/dpapi.mjs';
import {
  LOCAL_CONFIG_PATH,
  SESSION_PATH,
} from './lib/paths.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
  printHelp();
} else if (args.length > 0) {
  console.error(`未知参数：${args.join(' ')}`);
  console.error('运行 npm run acceptance:auth -- help 查看支持的参数。');
  process.exitCode = 1;
} else {
  await main();
}

async function main() {
  try {
    assertSafeConfigPath(LOCAL_CONFIG_PATH);
    assertSafeConfigPath(SESSION_PATH);
    if (isGitTracked(LOCAL_CONFIG_PATH) || isGitTracked(SESSION_PATH)) throw new Error('验收认证配置不得被 Git 跟踪');
    const config = loadAcceptanceAuthConfig();
    const username = (await promptLine(`用户名 [${config.username}]: `)).trim() || config.username;
    const password = await promptHidden('密码: ');
    const loginConfig = validateAcceptanceConfig({ ...config, username });
    const result = await loginAndStoreSession({
      config: loginConfig,
      password,
      protect: (value) => runDpapi('protect', value),
      writeSession: async (value) => {
        assertSafeConfigPath(SESSION_PATH);
        if (isGitTracked(SESSION_PATH)) throw new Error('验收认证配置不得被 Git 跟踪');
        writePrivateFile(SESSION_PATH, value);
      },
      writeConfig: async (value) => writeAcceptanceConfig(value),
    });
    console.log(`认证配置已保存：${result.username}，有效期至 ${result.expiresAt}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '认证配置失败');
    process.exitCode = 1;
  }
}

function promptLine(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (answer) => { rl.close(); resolve(answer); }));
}

function promptHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('密码输入需要交互式终端');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    readline.emitKeypressEvents(process.stdin);
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error) => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onKeypress = (character, key) => {
      if (key?.ctrl && key.name === 'c') return finish(new Error('认证已取消'));
      if (key?.name === 'return' || key?.name === 'enter') return finish(value ? null : new Error('密码不能为空'));
      if (key?.name === 'backspace') { value = value.slice(0, -1); return; }
      if (character && !key?.ctrl && !key?.meta) value += character;
    };
    process.stdin.on('keypress', onKeypress);
  });
}

function printHelp() {
  console.log(`Relay 页面验收认证\n\n用法：\n  npm run acceptance:auth\n\n说明：\n  在交互式终端隐藏读取密码，仅保存 DPAPI CurrentUser 加密的 relay_session Cookie。\n  不启动 Edge，不执行页面验收，不重启 Relay 服务。`);
}
