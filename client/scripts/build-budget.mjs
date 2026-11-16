import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const DEFAULT_BUILD_BUDGET = Object.freeze({
  // Existing totals remain trend warnings. These are not measured latency targets.
  maxChunkBytes: 500 * 1024,
  maxTotalBytes: 1.75 * 1024 * 1024,
  maxGzipTotalBytes: 548 * 1024,
  maxOfflineScriptBytes: 4 * 1024,
  // Both absolute and relative growth must exceed the line. Baselines never auto-advance.
  warningGrowth: Object.freeze({ bytes: 64 * 1024, ratio: 0.05 }),
  errorGrowth: Object.freeze({ bytes: 256 * 1024, ratio: 0.25 }),
});

export const ENTRY_POINTS = Object.freeze({
  bootstrap: ['index.html'],
  login: ['index.html', 'src/components/auth/LoginPage.tsx'],
  chat: ['index.html', { dynamicName: 'Layout' }, 'src/components/chat/ChatView.tsx'],
  share: ['index.html', 'src/components/sharing/PublicSharePage.tsx'],
  workbench: ['index.html', { dynamicName: 'Layout' }, 'src/components/workspace-console/WorkspaceConsolePage.tsx'],
  news: ['index.html', 'src/components/news/NewsPage.tsx'],
  tools: ['index.html', 'src/components/tools/ToolsPage.tsx'],
  newsAdmin: ['index.html', 'src/components/news/NewsAdminPage.tsx'],
  passwordChange: ['index.html', 'src/components/auth/PasswordChangeRequired.tsx'],
});

const metricKeys = ['jsBytes', 'jsGzipBytes', 'cssBytes', 'cssGzipBytes'];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validBytes = value => Number.isSafeInteger(value) && value >= 0;
function validateMetrics(value) {
  if (!isRecord(value) || metricKeys.some(key => !validBytes(value[key]))) throw new Error('体积指标无效');
}

export function collectBuildBudget(distDir, entries = ENTRY_POINTS) {
  const root = fs.realpathSync(distDir);
  const files = new Map();
  function file(relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.includes('\\') || relative.split('/').includes('..')) throw new Error('构建清单包含越界路径');
    if (files.has(relative)) return files.get(relative);
    const target = path.resolve(root, relative);
    const real = fs.realpathSync(target);
    if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile()) throw new Error('构建清单资源不在产物目录内');
    const bytes = fs.statSync(real).size;
    const gzipBytes = /\.(?:m?js|css)$/.test(relative) ? gzipSync(fs.readFileSync(real), { level: 9 }).length : 0;
    const value = { name: relative, bytes, gzipBytes };
    files.set(relative, value);
    return value;
  }
  function scan(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('构建产物不能包含符号链接');
      if (entry.isDirectory()) scan(relative);
      else if (entry.isFile() && /\.(?:m?js|css)$/.test(relative)) file(relative);
      if (files.size > 10_000) throw new Error('构建产物资源数量异常');
    }
  }
  file('index.html');
  const manifestFile = file('.vite/manifest.json');
  if (manifestFile.bytes > 8 * 1024 * 1024) throw new Error('构建清单过大');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestFile.name), 'utf8'));
  if (!isRecord(manifest) || Object.keys(manifest).length === 0) throw new Error('缺少有效构建清单');
  for (const node of Object.values(manifest)) {
    if (!isRecord(node)) throw new Error('构建清单条目无效');
    file(node.file);
    for (const key of ['imports', 'dynamicImports']) {
      if (node[key] !== undefined && (!Array.isArray(node[key]) || node[key].some(id => typeof id !== 'string' || !Object.hasOwn(manifest, id) || !/\.m?js$/.test(manifest[id]?.file)))) throw new Error('构建清单依赖缺失或不是JS模块');
    }
    for (const key of ['css', 'assets']) {
      if (node[key] !== undefined && !Array.isArray(node[key])) throw new Error('构建清单资源列表无效');
      for (const relative of node[key] || []) {
        if (key === 'css' && (typeof relative !== 'string' || !relative.endsWith('.css'))) throw new Error('构建清单CSS资源无效');
        file(relative);
      }
    }
  }
  scan('');
  const offlineScriptBytes = file('static-share-script.js').bytes;
  function metrics(js, css) {
    const sum = (names, key) => [...names].reduce((total, name) => total + file(name)[key], 0);
    return { jsBytes: sum(js, 'bytes'), jsGzipBytes: sum(js, 'gzipBytes'), cssBytes: sum(css, 'bytes'), cssGzipBytes: sum(css, 'gzipBytes') };
  }
  const routes = {};
  for (const [name, roots] of Object.entries(entries)) {
    const visited = new Set(), js = new Set(), css = new Set();
    function visit(id) {
      if (visited.has(id)) return;
      if (!Object.hasOwn(manifest, id)) throw new Error(`构建清单缺少入口：${name}`);
      visited.add(id);
      const node = manifest[id];
      if (!/\.m?js$/.test(node.file)) throw new Error(`入口不是JavaScript模块：${name}`);
      js.add(node.file);
      for (const asset of node.css || []) css.add(asset);
      for (const dependency of node.imports || []) visit(dependency);
    }
    for (const selector of roots) {
      if (typeof selector === 'string') visit(selector);
      else {
        // Vite can represent a shared dynamic entry without a source-path key.
        // Resolve explicit metadata, never a hash-bearing filename or a guessed nearest entry.
        const matches = Object.entries(manifest).filter(([, node]) => node.isDynamicEntry === true && node.name === selector.dynamicName);
        if (matches.length !== 1) throw new Error(`构建清单入口无法唯一确定：${name}`);
        visit(matches[0][0]);
      }
    }
    routes[name] = { ...metrics(js, css), jsFiles: [...js].sort(), cssFiles: [...css].sort() };
  }
  const js = new Set([...files.keys()].filter(name => /\.m?js$/.test(name) && name !== 'static-share-script.js'));
  const css = new Set([...files.keys()].filter(name => name.endsWith('.css')));
  return { schemaVersion: 1, totals: { ...metrics(js, css), offlineScriptBytes, jsFiles: js.size, cssFiles: css.size },
    routes, chunks: [...js].map(name => file(name)).sort((a, b) => b.bytes - a.bytes) };
}

export function createBudgetBaseline(report, source) {
  if (!source || !/^[a-f0-9]{40}$/.test(source.commit) || typeof source.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(source.version)) throw new Error('更新基线必须提供明确的源码提交和产品版本');
  validateMetrics(report.totals);
  for (const value of Object.values(report.routes)) validateMetrics(value);
  return { schemaVersion: 1, source: { commit: source.commit, version: source.version },
    totals: report.totals, routes: Object.fromEntries(Object.entries(report.routes).map(([key, value]) => [key, Object.fromEntries(metricKeys.map(metric => [metric, value[metric]]))])) };
}

export function evaluateBuildBudget(report, baseline, budget = DEFAULT_BUILD_BUDGET) {
  if (!isRecord(baseline) || baseline.schemaVersion !== 1 || !isRecord(baseline.routes) || !baseline.source || !/^[a-f0-9]{40}$/.test(baseline.source.commit) || typeof baseline.source.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(baseline.source.version)) throw new Error('缺少有效的已验收体积基线，不能自动跳过检查');
  validateMetrics(report.totals);
  for (const key of ['maxChunkBytes', 'maxTotalBytes', 'maxGzipTotalBytes', 'maxOfflineScriptBytes']) if (!validBytes(budget[key])) throw new Error('体积参考线无效');
  for (const level of ['warningGrowth', 'errorGrowth']) {
    if (!validBytes(budget[level]?.bytes) || !Number.isFinite(budget[level]?.ratio) || budget[level].ratio <= 0) throw new Error('体积增长策略无效');
  }
  if (budget.errorGrowth.bytes < budget.warningGrowth.bytes || budget.errorGrowth.ratio < budget.warningGrowth.ratio) throw new Error('体积阻断线不能低于告警线');
  const warnings = [], errors = [], routes = {};
  const warn = (code, message) => warnings.push({ code, message });
  if (report.totals.jsBytes > budget.maxTotalBytes) warn('TOTAL_JS', '全部JS总量超过趋势参考线，不阻断构建');
  if (report.totals.jsGzipBytes > budget.maxGzipTotalBytes) warn('TOTAL_GZIP_ESTIMATE', '全部JS的gzip估算超过趋势参考线，不代表实际传输量');
  if (report.totals.offlineScriptBytes > budget.maxOfflineScriptBytes) warn('OFFLINE_SCRIPT', '离线脚本超过轻量性参考线，请审阅新增交互');
  for (const chunk of report.chunks) if (chunk.bytes > budget.maxChunkBytes) warn('LARGE_CHUNK', `较大的JS分包：${chunk.name}`);
  for (const [id, current] of Object.entries(report.routes)) {
    const previous = baseline.routes[id];
    if (!previous) throw new Error(`体积基线缺少入口：${id}；新增入口需审阅后显式更新基线`);
    validateMetrics(current);
    validateMetrics(previous);
    const before = previous.jsBytes + previous.cssBytes;
    const after = current.jsBytes + current.cssBytes;
    const deltaBytes = after - before;
    const exceeds = line => deltaBytes > line.bytes && deltaBytes > before * line.ratio;
    const severity = exceeds(budget.errorGrowth) ? 'error' : exceeds(budget.warningGrowth) ? 'warning' : 'pass';
    routes[id] = { ...current, baselineBytes: before, deltaBytes, growthRatio: before ? deltaBytes / before : null, severity };
    const finding = { code: 'ENTRY_GROWTH', route: id, message: `入口${id}的JS+CSS相对固定基线增长${(deltaBytes / 1024).toFixed(2)} KiB` };
    if (severity === 'error') errors.push(finding);
    else if (severity === 'warning') warnings.push(finding);
  }
  return { ...report, baselineSource: baseline.source, routes, warnings, errors, ok: errors.length === 0, severity: errors.length ? 'error' : warnings.length ? 'warning' : 'pass' };
}
