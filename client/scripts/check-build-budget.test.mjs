import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectBuildBudget, createBudgetBaseline, evaluateBuildBudget, DEFAULT_BUILD_BUDGET } from './build-budget.mjs';
import { ENTRY_POINTS } from './build-budget.mjs';
import { runBuildBudget } from './check-build-budget.mjs';

const source = { commit: 'a'.repeat(40), version: '0.52.3' };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-budget-'));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, '.vite'));
  const manifest = {
    'index.html': { file: 'assets/main.js', imports: ['vendor'], dynamicImports: ['lazy'], css: ['assets/main.css'] },
    vendor: { file: 'assets/vendor.js' },
    shared: { file: 'assets/shared.js', imports: ['vendor'], css: ['assets/shared.css'] },
    chat: { file: 'assets/chat.js', imports: ['shared', 'vendor'], css: ['assets/shared.css'] },
    lazy: { file: 'assets/lazy.js', imports: ['vendor'] },
  };
  for (const keys of Object.values(ENTRY_POINTS)) for (const key of keys) {
    if (typeof key === 'string') { if (!manifest[key]) manifest[key] = { file: 'assets/chat.js', imports: ['shared'] }; }
    else manifest['_Layout-hash.js'] = { name: key.dynamicName, isDynamicEntry: true, file: 'assets/chat.js', imports: ['shared'] };
  }
  for (const name of ['main.js', 'vendor.js', 'shared.js', 'chat.js', 'lazy.js', 'main.css', 'shared.css']) fs.writeFileSync(path.join(root, 'assets', name), `/* ${name} */`);
  fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/assets/main.js"></script>');
  fs.writeFileSync(path.join(root, 'static-share-script.js'), '(()=>{})()');
  const write = () => fs.writeFileSync(path.join(root, '.vite', 'manifest.json'), JSON.stringify(manifest));
  write();
  return { root, manifest, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('入口按静态依赖与CSS去重，异步特性仅计入全应用总量', () => {
  const f = fixture();
  try {
    const result = collectBuildBudget(f.root, { boot: ['index.html'], chat: ['index.html', 'chat'] });
    assert.deepEqual(result.routes.boot.jsFiles, ['assets/main.js', 'assets/vendor.js']);
    assert.deepEqual(result.routes.chat.cssFiles, ['assets/main.css', 'assets/shared.css']);
    assert.equal(result.routes.chat.jsFiles.length, 4);
    assert.equal(result.routes.chat.jsFiles.includes('assets/lazy.js'), false);
    assert.equal(result.totals.jsFiles, 5);
    assert.equal(result.totals.cssFiles, 2);
    assert.equal(result.chunks.some(chunk => chunk.name === 'static-share-script.js'), false);
    assert(result.totals.offlineScriptBytes > 0);
  } finally { f.cleanup(); }
});

function sample(bytes = 1000) {
  const value = { jsBytes: bytes, jsGzipBytes: 100, cssBytes: 0, cssGzipBytes: 0 };
  return { schemaVersion: 1, totals: { ...value, offlineScriptBytes: 10 }, routes: { boot: { ...value } }, chunks: [{ name: 'assets/app.js', bytes, gzipBytes: 100 }] };
}
const policy = { ...DEFAULT_BUILD_BUDGET, warningGrowth: { bytes: 50, ratio: 0.1 }, errorGrowth: { bytes: 200, ratio: 0.5 } };

test('全应用、单包和离线脚本超过参考线只告警，不再阻断正常更新', () => {
  const report = sample(), baseline = createBudgetBaseline(report, source);
  const result = evaluateBuildBudget(report, baseline, { ...policy, maxChunkBytes: 1, maxTotalBytes: 1, maxGzipTotalBytes: 1, maxOfflineScriptBytes: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.severity, 'warning');
  assert.equal(result.warnings.length, 4);
  assert.equal(result.errors.length, 0);
});

test('增长必须同时超过绝对值和比例，边界及缩小均不误报', () => {
  const baseline = createBudgetBaseline(sample(), source);
  assert.equal(evaluateBuildBudget(sample(1100), baseline, policy).routes.boot.severity, 'pass');
  assert.equal(evaluateBuildBudget(sample(1101), baseline, policy).routes.boot.severity, 'warning');
  assert.equal(evaluateBuildBudget(sample(1500), baseline, policy).routes.boot.severity, 'warning');
  assert.equal(evaluateBuildBudget(sample(1501), baseline, policy).ok, false);
  assert.equal(evaluateBuildBudget(sample(900), baseline, policy).routes.boot.deltaBytes, -100);
  assert.equal(evaluateBuildBudget(sample(20), createBudgetBaseline(sample(10), source), policy).severity, 'pass');
  assert.equal(evaluateBuildBudget(sample(10_201), createBudgetBaseline(sample(10_000), source), policy).severity, 'pass');
});

test('CSS增长同样进入入口门禁，固定基线不会自动跟随新构建抬高', () => {
  const baseline = createBudgetBaseline(sample(), source), before = JSON.stringify(baseline), report = sample();
  report.routes.boot.cssBytes = 501;
  const result = evaluateBuildBudget(report, baseline, policy);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].route, 'boot');
  assert.equal(JSON.stringify(baseline), before);
});

test('缺失基线、入口或无效指标不能静默跳过门禁', () => {
  assert.throws(() => evaluateBuildBudget(sample(), null), /基线/);
  const baseline = createBudgetBaseline(sample(), source);
  delete baseline.routes.boot;
  assert.throws(() => evaluateBuildBudget(sample(), baseline), /缺少入口/);
  assert.throws(() => createBudgetBaseline(sample(), { commit: 'unknown', version: '0.52.3' }), /源码提交/);
  assert.throws(() => evaluateBuildBudget(sample(), createBudgetBaseline(sample(), source), { ...policy, errorGrowth: { bytes: 1, ratio: 0.01 } }), /不能低于/);
});

test('清单缺失、依赖丢失、异步文件缺失和越界路径必须失败', () => {
  for (const kind of ['manifest', 'dependency', 'dynamic-file', 'escape']) {
    const f = fixture();
    try {
      if (kind === 'manifest') fs.unlinkSync(path.join(f.root, '.vite', 'manifest.json'));
      if (kind === 'dependency') { f.manifest.chat.imports = ['missing']; f.write(); }
      if (kind === 'dynamic-file') fs.unlinkSync(path.join(f.root, 'assets', 'lazy.js'));
      if (kind === 'escape') { f.manifest.chat.file = '../outside.js'; f.write(); }
      assert.throws(() => collectBuildBudget(f.root));
    } finally { f.cleanup(); }
  }
});

test('循环静态依赖只访问一次，不造成重复统计或递归失败', () => {
  const f = fixture();
  try {
    f.manifest.vendor.imports = ['shared']; f.write();
    const report = collectBuildBudget(f.root, { boot: ['index.html'] });
    assert.equal(report.routes.boot.jsFiles.length, 3);
  } finally { f.cleanup(); }
});

test('共享动态入口按清单元数据匹配，缺失或重名时不能猜测入口', () => {
  const f = fixture();
  try {
    assert.equal(collectBuildBudget(f.root).routes.chat.jsFiles.length, 4);
    f.manifest['_Other-unknown.js'] = { name: 'Layout', isDynamicEntry: true, file: 'assets/chat.js' }; f.write();
    assert.throws(() => collectBuildBudget(f.root), /无法唯一确定/);
    delete f.manifest['_Layout-hash.js']; delete f.manifest['_Other-unknown.js']; f.write();
    assert.throws(() => collectBuildBudget(f.root), /无法唯一确定/);
  } finally { f.cleanup(); }
});

test('CLI正常报告不写基线，显式更新须带源码提交', () => {
  const f = fixture(), messages = [], output = { log: message => messages.push(message), error: message => messages.push(message) };
  const baselinePath = path.join(f.root, 'baseline.json');
  try {
    assert.throws(() => runBuildBudget([f.root, '--baseline', baselinePath, '--write-baseline'], output), /源码提交/);
    assert.equal(fs.existsSync(baselinePath), false);
    runBuildBudget([f.root, '--baseline', baselinePath, '--write-baseline', '--source-commit', source.commit], output);
    const before = fs.readFileSync(baselinePath, 'utf8');
    const result = runBuildBudget([f.root, '--baseline', baselinePath, '--json'], output);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(baselinePath, 'utf8'), before);
    assert.equal(JSON.parse(messages.at(-1)).baselineSource.commit, source.commit);
    assert.throws(() => runBuildBudget(['--unknown'], output), /未知参数/);
  } finally { f.cleanup(); }
});

test('真实CLI退出码区分普通增长告警和异常增长阻断', () => {
  const f = fixture(), baselinePath = path.join(f.root, 'baseline.json');
  try {
    fs.writeFileSync(baselinePath, JSON.stringify(createBudgetBaseline(collectBuildBudget(f.root), source)));
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./check-build-budget.mjs', import.meta.url)), f.root, '--baseline', baselinePath, '--json'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(f.root, 'assets', 'main.js'), 'x'.repeat(80 * 1024));
    const warning = run(); assert.equal(warning.status, 0, warning.stderr); assert.equal(JSON.parse(warning.stdout).severity, 'warning');
    fs.writeFileSync(path.join(f.root, 'assets', 'main.js'), 'x'.repeat(300 * 1024));
    const error = run(); assert.equal(error.status, 1, error.stderr); assert.equal(JSON.parse(error.stdout).severity, 'error');
    fs.unlinkSync(baselinePath);
    const missing = run(); assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).errors[0].code, 'INVALID_BUILD_OR_BASELINE');
  } finally { f.cleanup(); }
});
