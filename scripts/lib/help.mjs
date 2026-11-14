import fs from 'node:fs';

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const COMMANDS = {
  setup: {
    summary: '初始化或修复 Relay 项目环境',
    usage: 'npm run setup [help] [-- <参数>]',
    options: [
      ['help', '查看 setup 命令帮助'],
      ['--check-only', '只检查环境，不安装依赖'],
      ['--force', '强制重新安装前后端依赖'],
      ['--registry=current', '本次使用当前 npm registry'],
      ['--registry=china', '本次使用腾讯云 npm 镜像'],
      ['--registry=URL', '本次使用指定的 npm registry'],
    ],
    examples: [
      ['npm run setup', '初始化项目环境'],
      ['npm run setup help', '查看本命令帮助'],
      ['npm run setup -- --check-only', '只检查环境'],
      ['npm run setup -- --force', '强制重新安装依赖'],
      ['npm run setup -- --registry=china', '使用腾讯云镜像初始化'],
    ],
  },
  start: {
    summary: '以 production 模式启动 Relay；已有服务时显示状态并退出',
    usage: 'npm run start [help]',
    options: [
      ['help', '查看 start 命令帮助'],
    ],
    examples: [
      ['npm run start', '构建或复用版本化前端并启动 production'],
      ['npm run start help', '查看本命令帮助'],
    ],
    context: [
      '启动前检查未解决的 Git 冲突、依赖指纹和关键运行文件；异常时不会启动服务。',
      '依赖清单变化时先运行 npm run setup；已有服务时先运行 npm run stop。',
      '公网地址在 config/relay.conf 的 PUBLIC_ALLOWED_ADDRESSES 中配置。',
      '留空表示不允许公网地址；0.0.0.0 表示不限制公网地址（高风险）。',
    ],
  },
  dev: {
    summary: '以 development 模式启动 Relay 和 Vite HMR',
    usage: 'npm run dev [help] [-- <参数>]',
    options: [
      ['help', '查看 dev 命令帮助'],
      ['--lan', '显式监听局域网；默认仅监听 127.0.0.1'],
    ],
    examples: [
      ['npm run dev', '仅本机启动 development'],
      ['npm run dev -- --lan', '显式开放局域网 development'],
    ],
    context: ['development 使用 Vite HMR，不要求 production release 新鲜。'],
  },
  stop: {
    summary: '停止 Codex、Relay 后端和当前前端',
    usage: 'npm run stop [help]',
    options: [['help', '查看 stop 命令帮助']],
    examples: [
      ['npm run stop', '停止三个 Relay 服务'],
      ['npm run stop help', '查看本命令帮助'],
    ],
  },
  restart: {
    summary: '检查环境后停止三个服务并重新启动 Relay',
    usage: 'npm run restart [help] [-- <参数>]',
    options: [
      ['help', '查看 restart 命令帮助'],
      ['--dev', '切换为 development 模式'],
      ['--lan', '与 --dev 一起显式监听局域网'],
    ],
    examples: [
      ['npm run restart', '停止并重新启动 Relay'],
      ['npm run restart -- --dev', '切换为仅本机 development'],
      ['npm run restart -- --dev --lan', '切换为局域网 development'],
      ['npm run restart help', '查看本命令帮助'],
    ],
    context: [
      '环境检查在停止服务之前执行；未解决冲突或依赖过期时保留现有服务。',
      '依赖需要修复时先运行 npm run stop，再运行 npm run setup。',
    ],
  },
  check: {
    summary: '检查服务运行状态和项目环境状态',
    usage: 'npm run check [help]',
    options: [['help', '查看 check 命令帮助']],
    examples: [
      ['npm run check', '检查全部服务'],
      ['npm run check help', '查看本命令帮助'],
    ],
    context: [
      '同时检查 Git 合并状态、setup 依赖指纹和关键运行文件。',
      '服务已就绪但环境异常时仍返回非零退出码。',
    ],
  },
  'version:assess': {
    summary: '只读汇总上次产品版本变化后的累计改动',
    usage: 'npm run version:assess [help] | npm run --silent version:assess -- --json',
    options: [
      ['--json', '配合 npm --silent 输出 stdout 可直接解析的完整范围数据'],
      ['help', '查看 version:assess 命令帮助'],
    ],
    examples: [
      ['npm run version:assess', '快速查看收敛后的版本基线、提交和文件'],
      ['npm run --silent version:assess -- --json', '输出可直接解析的完整累计范围数据'],
    ],
    context: [
      '命令只读输出版本基线、评估范围和本地 upstream 状态，不根据文件数量自动决定 SemVer。',
      '普通文本只供快速查看；正式评估读取 silent JSON，并继续审查范围内的 diff 和关键提交。',
      '触发时机、远端同步和 push 顺序遵循项目 Git 规则。',
    ],
  },
  'performance:engines': {
    summary: '只读汇总本地引擎连接性能观测日志',
    usage: 'npm run performance:engines [help]',
    options: [['help', '查看 performance:engines 命令帮助']],
    examples: [['npm run performance:engines', '按引擎查看样本、成功率和阶段 p50/p95/max']],
    context: [
      '只读取项目根 logs/relay-*.log，不启动服务、不连接引擎，也不修改日志。',
      '报表只输出白名单性能字段，不输出会话标识、路径、prompt 或回复内容。',
    ],
  },
  'acceptance:auth': {
    summary: '交互式建立 DPAPI 加密的页面验收认证',
    usage: 'npm run acceptance:auth [-- help]',
    options: [['help', '查看认证命令帮助']],
    examples: [
      ['npm run acceptance:auth', '隐藏输入密码并保存加密 session'],
      ['npm run acceptance:auth -- help', '查看本命令帮助'],
    ],
    context: [
      '本机配置保存在 config/acceptance/，敏感文件被 Git 忽略。',
      '只保存 DPAPI CurrentUser 加密的 relay_session；不会保存密码，不会启动 Edge 或重启 Relay。',
    ],
  },
  'acceptance:page': {
    summary: '按显式门禁执行 Relay 无窗口页面验收',
    usage: 'npm run acceptance:page [-- help] | npm run acceptance:page -- --allow-engine-run --engine <codex|codebuddy|all> --scenario <complete|stop|refresh>',
    options: [
      ['help', '查看页面验收命令帮助'],
      ['--allow-engine-run', '显式允许本次真实引擎请求'],
      ['--engine <值>', '明确 codex、codebuddy 或 all'],
      ['--scenario <值>', '明确 complete、stop 或 refresh'],
    ],
    examples: [
      ['npm run acceptance:page', '执行默认只读桌面/移动视口验收'],
      ['npm run acceptance:page -- --allow-engine-run --engine codex --scenario complete', '执行一次明确授权的 Codex 完成场景'],
    ],
    context: [
      '默认只读，不创建会话、不发送消息、不停止任务。',
      '真实请求要求 allow、engine、scenario 三项同时明确；不会自动重启 Relay 或注入 Provider 故障。',
      '报告和截图写入 .relay-dev/acceptance/<runId>/。',
    ],
  },
  'screenshots:readme': {
    summary: '按明确请求截取当前production界面的脱敏文档图片',
    usage: 'npm run screenshots:readme [-- help]',
    options: [['help', '查看文档截图命令帮助']],
    examples: [['npm run screenshots:readme', '先核对acceptance:status，再截取首页、工具集和固定示例场景']],
    context: [
      '仅在用户明确要求时执行；默认只读，不创建业务数据、不发送消息、不重启服务。',
      '使用本机加密验收认证和独立Edge profile，截图前隐藏个人信息，不重绘界面。',
      '助手三视图、多引擎维护和Markdown/Git/HTML预览使用浏览器内存示例，隔离真实引擎连接及API写入；必须标注为示例。',
      '图片及清理报告保存在 .relay-dev/acceptance/<runId>/；人工检查后只复制选中图片到文档。',
    ],
  },
  'acceptance:status': {
    summary: '只读检查页面验收运行状态与残留资源',
    usage: 'npm run acceptance:status [-- help]',
    options: [['help', '查看状态命令帮助']],
    examples: [['npm run acceptance:status', '只读列出验收工具运行状态']],
    context: ['命令只读，不启动 Edge、不结束进程、不删除 profile。'],
  },
  'acceptance:cleanup': {
    summary: '按明确 run ID 精确清理验收工具资源',
    usage: 'npm run acceptance:cleanup -- --run-id <runId>',
    options: [
      ['--run-id <runId>', '只接受 .relay-dev/acceptance 下的明确 run ID'],
      ['help', '查看清理命令帮助'],
    ],
    examples: [['npm run acceptance:cleanup -- --run-id run-<id>', '精确清理单次验收运行']],
    context: ['拒绝宽泛目录和按进程名批量结束 Edge，只处理唯一 profile 匹配的资源。'],
  },
  'worktree:clean': {
    summary: '安全清理项目 .worktrees 下已合并的临时 worktree',
    usage: 'npm run worktree:clean -- <名称> | npm run worktree:clean -- --check',
    options: [
      ['<名称>', '只接受 .worktrees 下的单级目录名称'],
      ['--check', '只检查并列出项目临时 worktree，不执行删除'],
      ['help', '查看 worktree:clean 命令帮助'],
    ],
    examples: [
      ['npm run worktree:clean -- --check', '只读检查临时 worktree'],
      ['npm run worktree:clean -- theme-preview-bar', '清理已合并且工作区干净的指定 worktree'],
      ['npm run worktree:clean help', '查看本命令帮助'],
    ],
    context: [
      '命令拒绝绝对路径、路径分隔符、未提交修改、未合并分支和 main 分支。',
      '只使用非强制的 git worktree remove 与 git branch -d。',
      '固定命令前缀可作为 .worktrees 清理的长期授权，不应放行任意删除命令。',
    ],
  },
  'test:scripts': {
    summary: '开发维护：修改根脚本后运行回归测试',
    usage: 'npm run test:scripts [help]',
    options: [['help', '查看 test:scripts 命令帮助']],
    context: [
      '修改 setup、start、help 或相关公共模块后，验证根目录脚本没有发生回归。',
      '普通安装、启动和使用 Relay 时无需执行。',
    ],
    examples: [
      ['npm run test:scripts', '运行根脚本测试'],
      ['npm run test:scripts help', '查看本命令帮助'],
    ],
  },
};

export function hasHelpArgument(args) {
  return args.includes('help') || args.includes('--help');
}

function formatRows(rows, indent = '  ') {
  const width = Math.max(...rows.map(([command]) => command.length));
  return rows.map(([command, description]) => `${indent}${command.padEnd(width)}  ${description}`).join('\n');
}

export function formatProjectHelp() {
  return [
    `Relay 项目命令 v${PACKAGE.version}`,
    '',
    '主要命令',
    '',
    formatRows([
      ['npm run setup', COMMANDS.setup.summary],
      ['npm run start', COMMANDS.start.summary],
      ['npm run dev', COMMANDS.dev.summary],
      ['npm run stop', COMMANDS.stop.summary],
      ['npm run restart', COMMANDS.restart.summary],
      ['npm run check', COMMANDS.check.summary],
    ]),
    '',
    '开发维护（普通使用无需执行）',
    '',
    formatRows([
      ['npm run version:assess', COMMANDS['version:assess'].summary],
      ['npm run performance:engines', COMMANDS['performance:engines'].summary],
      ['npm run worktree:clean', COMMANDS['worktree:clean'].summary],
      ['npm run test:scripts', '修改 setup、start 或 help 后运行回归测试'],
    ]),
    '',
    '页面验收（默认不运行）',
    '',
    formatRows([
      ['npm run acceptance:auth', COMMANDS['acceptance:auth'].summary],
      ['npm run acceptance:page', COMMANDS['acceptance:page'].summary],
      ['npm run screenshots:readme', COMMANDS['screenshots:readme'].summary],
      ['npm run acceptance:status', COMMANDS['acceptance:status'].summary],
      ['npm run acceptance:cleanup', COMMANDS['acceptance:cleanup'].summary],
    ]),
    '',
    '查看详细用法：npm run <命令> help',
    '例如：npm run setup help',
  ].join('\n');
}

export function formatCommandHelp(name) {
  const command = COMMANDS[name];
  if (!command) return null;
  return [
    `${name} — ${command.summary}`,
    '',
    `用法：${command.usage}`,
    '',
    '参数',
    '',
    formatRows(command.options),
    '',
    '示例',
    '',
    formatRows(command.examples),
    ...(command.context ? ['', '适用场景', '', ...command.context.map((line) => `  ${line}`)] : []),
  ].join('\n');
}

export function commandNames() {
  return Object.keys(COMMANDS);
}

export function printHelp(output, write = console.log) {
  write(output);
  write('');
}
