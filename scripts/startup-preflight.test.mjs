import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  formatStartupPreflight,
  inspectStartupPreflight,
  reportStartupPreflight,
  runProtectedRestart,
} from './lib/startup-preflight.mjs';
import {
  hashDependencyManifests,
  hashFiles,
  writeSetupState,
} from './lib/setup-core.mjs';

function createTempProject(prefix) {
  const base = path.join(process.cwd(), '.relay-setup', 'test-tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

function prepareArea(root, name, dependencies) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ dependencies }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, 'package-lock.json'), `${JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2)}\n`);
  const criticalFiles = name === 'server'
    ? ['node_modules/.bin/tsx.cmd', 'node_modules/.bin/tsc.cmd']
    : [
        'node_modules/.bin/vite.cmd',
        'node_modules/.bin/tsc.cmd',
        'node_modules/vite/bin/vite.js',
        'node_modules/@vitejs/plugin-react/dist/index.js',
        'node_modules/@babel/core/package.json',
      ];
  for (const relativePath of criticalFiles) {
    const target = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }
  return {
    fingerprint: hashDependencyManifests([
      path.join(directory, 'package.json'),
      path.join(directory, 'package-lock.json'),
    ], ['node-major:25']),
  };
}

function prepareInitializedProject(root) {
  const server = prepareArea(root, 'server', { hono: '1.0.0' });
  const client = prepareArea(root, 'client', { react: '19.0.0' });
  writeSetupState(path.join(root, '.relay-setup', 'setup-state.json'), {
    engines: {
      codex: { cliInstalled: false, protocolReady: false, available: false, version: null },
      codebuddy: { cliInstalled: false, authReady: false, protocolReady: false, available: false, version: null },
      opencode: { cliInstalled: false, protocolReady: false, available: false, version: null },
      zcode: { cliInstalled: false, protocolReady: false, available: false, version: null },
    },
    areas: {
      server: { fingerprint: server.fingerprint },
      client: { fingerprint: client.fingerprint },
    },
  });
}

test('unsupported SQLite runtime fails before protected restart can stop an existing service',async()=>{
  const root=createTempProject('startup-native-authority-');let stopped=false;
  try{
    prepareInitializedProject(root);
    const result=inspectStartupPreflight({root,nodeVersion:'v25.4.0',platform:'win32',runGit:()=>({status:0,stdout:''}),runStorageCheck:()=>({status:1})});
    assert.equal(result.ok,false);assert.equal(result.storage.code,'STORAGE_RUNTIME_UNSUPPORTED');
    assert.equal(await runProtectedRestart({inspect:()=>result,report:result=>result.ok?0:1,stop:async()=>{stopped=true;return 0;},start:async()=>{throw Error('must not start');}}),1);
    assert.equal(stopped,false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('启动前检查接受无冲突且依赖指纹一致的环境', () => {
  const root = createTempProject('startup-preflight-ok-');
  try {
    prepareInitializedProject(root);
    const result = inspectStartupPreflight({
      root,
      nodeVersion: 'v25.4.0',
      platform: 'win32',
      runGit: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.conflictFiles, []);
    assert.equal(result.areas.client.needed, false);
    assert.equal(result.areas.server.needed, false);
    assert.equal(result.enginesReady, false);
    assert.match(formatStartupPreflight(result).join('\n'), /暂无可用引擎（不影响 Relay 启动，可稍后配置）/);
    assert.match(formatStartupPreflight(result).join('\n'), /所需组件已就绪；启动时检查数据版本，必要时自动升级/);
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.relay-setup', 'setup-state.json'), 'utf8'));
    saved.engines.opencode = { cliInstalled: true, protocolReady: true, available: true };
    writeSetupState(path.join(root, '.relay-setup', 'setup-state.json'), saved);
    const openCodeOnly = inspectStartupPreflight({root,nodeVersion:'v25.4.0',platform:'win32',runGit:()=>({status:0,stdout:''})});
    assert.equal(openCodeOnly.enginesReady,true);
    assert.match(formatStartupPreflight(openCodeOnly).join('\n'), /AI 引擎（最近检测）：OpenCode 可用/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('依赖清单变化时要求先运行 setup', () => {
  const root = createTempProject('startup-preflight-dependency-');
  try {
    prepareInitializedProject(root);
    const clientManifest = path.join(root, 'client', 'package.json');
    fs.writeFileSync(clientManifest, `${JSON.stringify({ dependencies: { react: '19.0.0', '@dnd-kit/core': '6.3.1' } }, null, 2)}\n`);
    const result = inspectStartupPreflight({
      root,
      nodeVersion: 'v25.4.0',
      platform: 'win32',
      runGit: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.areas.client.reason, '依赖清单发生变化');
    assert.match(formatStartupPreflight(result).join('\n'), /npm run setup/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('没有成功初始化记录时阻止启动', () => {
  const root = createTempProject('startup-preflight-state-');
  try {
    prepareArea(root, 'server', { hono: '1.0.0' });
    prepareArea(root, 'client', { react: '19.0.0' });
    const result = inspectStartupPreflight({
      root,
      nodeVersion: 'v25.4.0',
      platform: 'win32',
      runGit: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.areas.server.reason, '没有成功初始化记录');
    assert.equal(result.areas.client.reason, '没有成功初始化记录');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('启动前检查兼容旧版完整文件指纹', () => {
  const root = createTempProject('startup-preflight-legacy-');
  try {
    prepareInitializedProject(root);
    const statePath = path.join(root, '.relay-setup', 'setup-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const areaName of ['server', 'client']) {
      state.areas[areaName].fingerprint = hashFiles([
        path.join(root, areaName, 'package.json'),
        path.join(root, areaName, 'package-lock.json'),
      ], ['node-major:25']);
    }
    writeSetupState(statePath, { areas: state.areas });
    const result = inspectStartupPreflight({
      root,
      nodeVersion: 'v25.4.0',
      platform: 'win32',
      runGit: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Git 未合并文件会被列出并阻止启动', () => {
  const root = createTempProject('startup-preflight-conflict-');
  try {
    prepareInitializedProject(root);
    const result = inspectStartupPreflight({
      root,
      nodeVersion: 'v25.4.0',
      platform: 'win32',
      runGit: () => ({
        status: 0,
        stdout: 'client/src/components/layout/Sidebar.tsx\nclient/src/components/chat/MessageList.tsx\n',
        stderr: '',
      }),
    });
    const output = formatStartupPreflight(result).join('\n');
    assert.equal(result.ok, false);
    assert.deepEqual(result.conflictFiles, [
      'client/src/components/layout/Sidebar.tsx',
      'client/src/components/chat/MessageList.tsx',
    ]);
    assert.match(output, /存在未解决的 Git 冲突/);
    assert.match(output, /Sidebar\.tsx/);
    assert.match(output, /本次不会启动或停止任何服务/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('不在 Git 仓库或 Git 不可用时不影响依赖检查', () => {
  const root = createTempProject('startup-preflight-no-git-');
  try {
    prepareInitializedProject(root);
    const result = inspectStartupPreflight({
      root,
      nodeVersion: 'v25.4.0',
      platform: 'win32',
      runGit: () => ({ status: 128, stdout: '', stderr: 'not a git repository' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.gitAvailable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('前置检查失败时 restart 不会停止当前服务', async () => {
  const calls = [];
  const exitCode = await runProtectedRestart({
    inspect: () => ({ ok: false }),
    report: (result) => {
      calls.push(['report', result.ok]);
      return 1;
    },
    stop: async () => {
      calls.push(['stop']);
      return 0;
    },
    start: async () => calls.push(['start']),
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, [['report', false]]);
});

test('restart 只在检查通过后依次停止和启动服务', async () => {
  const calls = [];
  const exitCode = await runProtectedRestart({
    inspect: () => ({ ok: true }),
    report: (result) => {
      calls.push(['report', result.ok]);
      return 0;
    },
    stop: async () => {
      calls.push(['stop']);
      return 0;
    },
    start: async () => calls.push(['start']),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [['report', true], ['stop'], ['start']]);
});

test('前置检查报告返回与环境状态一致的退出码', () => {
  const output = [];
const result = {
    ok: false,
    gitAvailable: true,
    conflictFiles: [],
    dependenciesReady: false,
    enginesReady: false,
    areas: {
      server: { needed: false, reason: '依赖已安装且未发生变化' },
      client: { needed: true, reason: '依赖清单发生变化' },
    },
  };
  assert.equal(reportStartupPreflight(result, (line) => output.push(line)), 1);
  assert.match(output.join('\n'), /先运行 npm run stop/);
  assert.doesNotMatch(output.join('\n'), /安装并登录 Codex/);
});
