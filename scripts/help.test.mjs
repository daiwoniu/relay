import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { commandNames, formatCommandHelp, formatProjectHelp, hasHelpArgument, printHelp } from './lib/help.mjs';

const rootPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('识别裸 help 和兼容帮助参数', () => {
  assert.equal(hasHelpArgument(['help']), true);
  assert.equal(hasHelpArgument(['--help']), true);
  assert.equal(hasHelpArgument(['--force']), false);
});

test('总帮助只展示命令索引和详细帮助引导', () => {
  const output = formatProjectHelp();
  for (const command of commandNames()) assert.match(output, new RegExp(`npm run ${command.replace(':', '\\:')}`));
  assert.match(output, /Relay 项目命令/);
  assert.equal(output.includes(`Relay 项目命令 v${rootPackage.version}`), true);
  assert.match(output, /npm run stop/);
  assert.match(output, /npm run restart/);
  assert.match(output, /查看详细用法：npm run <命令> help/);
  assert.match(output, /开发维护（普通使用无需执行）/);
  assert.doesNotMatch(output, /--force/);
  assert.doesNotMatch(output, /--verbose/);
});

test('帮助输出末尾增加空行', () => {
  const lines = [];
  printHelp('帮助内容', (line) => lines.push(line));
  assert.deepEqual(lines, ['帮助内容', '']);
});

test('具体命令帮助包含用法、参数和示例', () => {
  const output = formatCommandHelp('start');
  assert.match(output, /用法：npm run start/);
  assert.doesNotMatch(output, /--verbose/);
  assert.match(output, /npm run start help/);
  assert.match(output, /config\/relay\.conf/);
  assert.match(output, /PUBLIC_ALLOWED_ADDRESSES/);
  assert.equal(formatCommandHelp('unknown'), null);
});

test('根脚本测试帮助说明开发使用场景', () => {
  const output = formatCommandHelp('test:scripts');
  assert.match(output, /修改 setup、start、help/);
  assert.match(output, /普通安装、启动和使用 Relay 时无需执行/);
});

test('版本评估帮助说明只读范围证据与语义审查边界', () => {
  const output = formatCommandHelp('version:assess');
  assert.match(output, /npm run --silent version:assess -- --json/);
  assert.match(output, /正式评估读取 silent JSON/);
  assert.match(output, /不根据文件数量自动决定 SemVer/);
  assert.match(output, /diff 和关键提交/);
  assert.match(output, /遵循项目 Git 规则/);
  assert.match(formatProjectHelp(), /npm run version:assess/);
});

test('worktree 清理帮助强调限定目录和非强制保护', () => {
  const output = formatCommandHelp('worktree:clean');
  assert.match(output, /\.worktrees/);
  assert.match(output, /--check/);
  assert.match(output, /未提交修改/);
  assert.match(output, /非强制/);
  assert.match(formatProjectHelp(), /npm run worktree:clean/);
});

test('停止和重启帮助说明服务生命周期', () => {
  assert.match(formatCommandHelp('stop'), /停止三个 Relay 服务/);
  assert.doesNotMatch(formatCommandHelp('restart'), /--verbose/);
  assert.match(formatCommandHelp('restart'), /环境检查在停止服务之前执行/);
  assert.match(formatCommandHelp('restart'), /保留现有服务/);
});

test('启动和检查帮助说明 setup 与 Git 前置检查', () => {
  assert.match(formatCommandHelp('start'), /未解决的 Git 冲突/);
  assert.match(formatCommandHelp('start'), /npm run setup/);
  assert.match(formatCommandHelp('check'), /项目环境状态/);
  assert.match(formatCommandHelp('check'), /依赖指纹/);
});

test('页面验收与文档截图命令帮助完整登记安全门禁', () => {
  const project = formatProjectHelp();
  for (const command of ['acceptance:auth', 'acceptance:page', 'screenshots:readme', 'acceptance:status', 'acceptance:cleanup']) {
    assert.ok(commandNames().includes(command));
    assert.match(project, new RegExp(`npm run ${command}`));
  }
  assert.match(formatCommandHelp('acceptance:auth'), /config\/acceptance/u);
  assert.match(formatCommandHelp('acceptance:auth'), /不会启动 Edge/u);
  assert.match(formatCommandHelp('acceptance:page'), /默认只读/u);
  assert.match(formatCommandHelp('acceptance:page'), /--allow-engine-run/u);
  assert.match(formatCommandHelp('acceptance:page'), /--engine/u);
  assert.match(formatCommandHelp('acceptance:page'), /--scenario/u);
  assert.match(formatCommandHelp('acceptance:page'), /不会自动重启/u);
  assert.match(formatCommandHelp('acceptance:status'), /只读/u);
  assert.match(formatCommandHelp('screenshots:readme'), /不创建业务数据/u);
  assert.match(formatCommandHelp('screenshots:readme'), /不重绘界面/u);
  assert.match(formatCommandHelp('acceptance:cleanup'), /明确 run ID/u);
});
