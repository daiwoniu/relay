import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activatePreparedFrontendBuild,
  formatFrontendBuildLabel,
  getFrontendBuildPaths,
  getFrontendBuildStatus,
  promoteFrontendRelease,
  prepareFrontendBuild,
  prepareFrontendBuildInWorker,
  readFrontendBuildState,
  resolveFrontendBuildForLaunch,
  verifyPreparedFrontendBuild,
  writeFrontendBuildState,
} from './lib/frontend-build.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServiceFileLogger } from './lib/service-file-logging.mjs';
import { createLauncherOutputWriter } from './lib/launcher-core.mjs';

test('生产构建标签使用紧凑本地时间与七位短 ID', () => {
  const createdAt = new Date(2026, 7, 9, 14, 10).getTime();
  assert.equal(formatFrontendBuildLabel(createdAt, 'abcdef123456'), '20260809-1410 · abcdef1');
  assert.equal(formatFrontendBuildLabel(Number.NaN, 'abcdef123456'), null);
});

test('release 提升遇到 Windows 瞬时占用时退避重试 rename', () => {
  const calls = [];
  const waits = [];
  const rename = () => {
    calls.push('rename');
    if (calls.length < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
  };
  const result = promoteFrontendRelease({
    distPath: 'staging/dist',
    releasePath: 'releases/build',
    rename,
    copy: () => assert.fail('rename 成功后不应复制'),
    wait: (milliseconds) => waits.push(milliseconds),
  });
  assert.deepEqual(result, { method: 'rename', retries: 2 });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [60, 120]);
});

test('release 提升持续被占用时复制完整产物并移除 staging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-frontend-promote-'));
  try {
    const distPath = path.join(root, 'staging', 'dist');
    const releasePath = path.join(root, 'releases', 'abcdef123456');
    fs.mkdirSync(path.join(distPath, 'assets'), { recursive: true });
    fs.mkdirSync(path.dirname(releasePath), { recursive: true });
    fs.writeFileSync(path.join(distPath, 'assets', 'app.js'), 'ok');
    fs.writeFileSync(path.join(distPath, 'index.html'), '<script src="/assets/app.js"></script>');
    let renameAttempts = 0;
    const result = promoteFrontendRelease({
      distPath,
      releasePath,
      rename: () => {
        renameAttempts += 1;
        throw Object.assign(new Error('busy'), { code: 'EPERM' });
      },
      wait: () => undefined,
    });
    assert.deepEqual(result, { method: 'copy', retries: 3 });
    assert.equal(renameAttempts, 4);
    assert.equal(fs.existsSync(distPath), false);
    assert.equal(fs.readFileSync(path.join(releasePath, 'assets', 'app.js'), 'utf8'), 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release 复制兜底失败时清理半成品并保留 staging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-frontend-promote-failure-'));
  try {
    const distPath = path.join(root, 'staging', 'dist');
    const releasePath = path.join(root, 'releases', 'abcdef123456');
    fs.mkdirSync(path.join(distPath, 'assets'), { recursive: true });
    fs.mkdirSync(path.dirname(releasePath), { recursive: true });
    fs.writeFileSync(path.join(distPath, 'assets', 'app.js'), 'ok');
    fs.writeFileSync(path.join(distPath, 'index.html'), '<script src="/assets/app.js"></script>');
    assert.throws(() => promoteFrontendRelease({
      distPath,
      releasePath,
      rename: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
      copy: (_source, target) => {
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'index.html'), 'incomplete');
        throw new Error('copy failed');
      },
      wait: () => undefined,
    }), /前端 release 发布失败：copy failed/);
    assert.equal(fs.existsSync(releasePath), false);
    assert.equal(fs.existsSync(distPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-frontend-build-'));
  fs.mkdirSync(path.join(root, 'client', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'client', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  for (const [file, content] of Object.entries({
    'package.json': '{"name":"relay","version":"0.1.0"}',
    'client/src/main.tsx': 'export const app = true;',
    'client/index.html': '<script type="module" src="/src/main.tsx"></script>',
    'client/vite.config.ts': 'export default {};',
    'client/vite-public-access.mjs': 'export {};',
    'client/package.json': '{}',
    'client/package-lock.json': '{}',
    'client/tsconfig.json': '{}',
    'client/scripts/check-build-budget.mjs': 'export {};',
    'scripts/lib/frontend-access.mjs': 'export {};',
  })) fs.writeFileSync(path.join(root, file), content);
  return root;
}

function successfulRunner(command, args) {
  if (command !== 'npm' || !args.includes('vite')) return;
  const outDir = args[args.indexOf('--outDir') + 1];
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'assets', 'app-abcdef12.js'), 'ok');
  fs.writeFileSync(path.join(outDir, 'index.html'), '<script src="/assets/app-abcdef12.js"></script>');
}

test('版本化前端构建准备、复用、激活并检测源码陈旧', () => {
  const root = createRoot();
  try {
    const createdAt = new Date(2026, 7, 9, 14, 10).getTime();
    const progress = [], phases = ['正在检查前端代码...', '正在打包前端界面，请稍候...', '正在检查前端构建完整性和体积...'];
    let commands = 0;
    const first = prepareFrontendBuild({ root, onProgress: line => progress.push(line), run: (command,args) => {
      assert.equal(progress.at(-1),phases[commands++],'each blocking command must have a visible phase before it runs');
      successfulRunner(command,args);
    }, now: () => createdAt });
    assert.equal(commands,3);
    assert.equal(first.reused, false);
    assert.equal(first.buildLabel, `20260809-1410 · ${first.buildId.slice(0, 7)}`);
    assert.equal(fs.existsSync(path.join(first.releasePath, 'index.html')), true);
    assert.equal(readFrontendBuildState(getFrontendBuildPaths(root).state).preparedBuildId, first.buildId);
    activatePreparedFrontendBuild(root);
    assert.equal(getFrontendBuildStatus(root).activeBuildLabel, first.buildLabel);
    assert.equal(getFrontendBuildStatus(root).fresh, true);
    progress.length=0;
    const second = prepareFrontendBuild({ root, onProgress: line => progress.push(line), run: () => assert.fail('完整 release 不应重复构建') });
    assert.equal(second.reused, true);
    assert.deepEqual(progress,['正在检查前端是否需要更新...'],'cache reuse must not claim a new build is running');
    fs.appendFileSync(path.join(root, 'client', 'src', 'main.tsx'), '\nexport const changed = true;');
    assert.equal(getFrontendBuildStatus(root).fresh, false);
    assert.equal(getFrontendBuildStatus(root).reason, '前端源码较活动构建更新');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('构建阶段和成功工具输出落盘，终端保持简洁且文件日志脱敏', async () => {
  const root=createRoot(), terminal=[];
  const logger=createServiceFileLogger({root,warn:()=>{}});
  const output=createLauncherOutputWriter({write:line=>terminal.push(line),writeEvent:line=>logger.writeEvent(line)});
  try{
    prepareFrontendBuild({root,onProgress:output.write,
      onOutput:(channel,chunk)=>logger.writeServiceChunk('frontend-build',channel,chunk),
      run:(command,args,options)=>{
        options.onOutput('stdout','compiled token=build-secret\n');
        options.onOutput('stderr','\u001b[33mwarning Authorization: Bearer build-secret\u001b[0m\n');
        successfulRunner(command,args);
      }});
    await logger.close();
    const log=fs.readFileSync(logger.currentRunLogPath,'utf8');
    assert.match(log,/\[启动器\] \[事件\] 正在检查前端代码/);
    assert.match(log,/\[前端生产构建\] \[标准输出\] compiled token=\[已隐藏\]/);
    assert.match(log,/\[前端生产构建\] \[标准错误\] warning Authorization: \[已隐藏\]/);
    assert.doesNotMatch(log,/build-secret|\u001b/);
    assert.ok(terminal.every(line=>!line.includes('compiled')&&!line.includes('warning')));
  }finally{await logger.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('精确预构建校验不受后续源码变化影响且拒绝被覆盖的 prepared 指针', () => {
  const root = createRoot();
  try {
    const first = prepareFrontendBuild({ root, run: successfulRunner });
    fs.appendFileSync(path.join(root, 'client', 'src', 'main.tsx'), '\nexport const changedAfterPrepare = true;');
    assert.equal(resolveFrontendBuildForLaunch({
      root,
      preparedBuildId: first.buildId,
      prepare: () => assert.fail('跨进程换代不得按变化后的源码再次构建'),
    }).buildId, first.buildId);
    const second = prepareFrontendBuild({ root, run: successfulRunner });
    assert.throws(() => verifyPreparedFrontendBuild(root, first.buildId), /预构建身份不一致/);
    assert.equal(verifyPreparedFrontendBuild(root, second.buildId).buildId, second.buildId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('根 package 版本变化会使活动前端构建过期并生成新构建', () => {
  const root = createRoot();
  try {
    const first = prepareFrontendBuild({ root, run: successfulRunner });
    activatePreparedFrontendBuild(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"relay","version":"0.1.1"}');
    assert.equal(getFrontendBuildStatus(root).fresh, false);
    assert.equal(getFrontendBuildStatus(root).reason, '前端源码较活动构建更新');
    const next = prepareFrontendBuild({ root, run: successfulRunner });
    assert.equal(next.reused, false);
    assert.notEqual(next.buildId, first.buildId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('构建失败清理已核验 staging 且不改变活动指针', () => {
  const root = createRoot();
  try {
    const paths = getFrontendBuildPaths(root);
    writeFrontendBuildState(paths.state, { schemaVersion: 1, activeBuildId: 'aaaaaaaaaaaa', previousBuildId: null, preparedBuildId: null, builds: {} });
    assert.throws(() => prepareFrontendBuild({ root, run: () => { throw new Error('构建失败'); } }), /构建失败/);
    assert.equal(readFrontendBuildState(paths.state).activeBuildId, 'aaaaaaaaaaaa');
    assert.deepEqual(fs.readdirSync(paths.staging), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release 缺少 index 引用资源时不得复用或报告 fresh', () => {
  const root = createRoot();
  try {
    const first = prepareFrontendBuild({ root, run: successfulRunner });
    activatePreparedFrontendBuild(root);
    const html = fs.readFileSync(path.join(first.releasePath, 'index.html'), 'utf8');
    const reference = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => new URL(match[1], 'http://relay.local').pathname)
      .find((pathname) => pathname.startsWith('/assets/'));
    assert.ok(reference);
    fs.rmSync(path.join(first.releasePath, reference.replace(/^\//, '')));
    assert.equal(getFrontendBuildStatus(root).fresh, false);
    const rebuilt = prepareFrontendBuild({ root, run: successfulRunner });
    assert.equal(rebuilt.reused, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('异步构建 worker 不阻塞启动器事件循环并转发输出', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stdout = [];
  const stderr = [];
  let eventLoopResponsive = false;
  const promise = prepareFrontendBuildInWorker({
    root: 'G:\\AI\\relay',
    spawnFn: () => child,
    onStdout: (chunk) => stdout.push(String(chunk)),
    onStderr: (chunk) => stderr.push(String(chunk)),
  });
  setImmediate(() => { eventLoopResponsive = true; });
  child.stdout.write('vite building\n');
  child.stderr.write('warning\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventLoopResponsive, true);
  child.emit('message', { channel: 'relay-frontend-build-worker-v1', type: 'result', status: 'completed', buildId: 'abcdef123456', buildLabel: '20260829-0935 · abcdef1', reused: false, message: null });
  child.emit('exit', 0, null);
  assert.deepEqual(await promise, { buildId: 'abcdef123456', buildLabel: '20260829-0935 · abcdef1', reused: false });
  assert.deepEqual(stdout, ['vite building\n']);
  assert.deepEqual(stderr, ['warning\n']);
});

test('异步构建 worker 拒绝畸形结果和失败退出', async () => {
  const spawnWorker = (response, exitCode = 0) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      if (response) child.emit('message', response);
      child.emit('exit', exitCode, null);
    });
    return child;
  };
  await assert.rejects(() => prepareFrontendBuildInWorker({
    root: 'G:\\AI\\relay',
    spawnFn: () => spawnWorker({ channel: 'relay-frontend-build-worker-v1', type: 'result', status: 'completed', buildId: '../bad', buildLabel: null, reused: false, message: null }),
  }), /无效结果/);
  await assert.rejects(() => prepareFrontendBuildInWorker({
    root: 'G:\\AI\\relay',
    spawnFn: () => spawnWorker({ channel: 'relay-frontend-build-worker-v1', type: 'result', status: 'failed', buildId: null, buildLabel: null, reused: false, message: '构建失败' }, 1),
  }), /构建失败/);
});
