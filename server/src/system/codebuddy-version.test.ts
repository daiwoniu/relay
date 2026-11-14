import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createCodeBuddyVersionService, extractCodeBuddyVersion, fetchCodeBuddyRelease, getCodeBuddyVersionCommand } from './codebuddy-version.js';

test('CodeBuddy 版本解析和跨平台命令保持固定', () => {
  assert.equal(extractCodeBuddyVersion('CodeBuddy CLI v2.141.0'), '2.141.0');
  assert.deepEqual(getCodeBuddyVersionCommand('linux'), { file: 'codebuddy', args: ['--version'] });
  assert.deepEqual(getCodeBuddyVersionCommand('win32', 'C:\\Windows\\cmd.exe'), {
    file: 'C:\\Windows\\cmd.exe',
    args: ['/d', '/s', '/c', 'codebuddy.cmd --version'],
  });
});

test('CodeBuddy 未安装时版本探测不向控制台输出错误', () => {
  const moduleUrl = new URL('./codebuddy-version.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    `const module = await import(${JSON.stringify(moduleUrl)}); module.readInstalledCodeBuddyVersion();`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PATH: '', RELAY_CODEBUDDY_VERSION: '' },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('读取快照时刷新实际安装版本以反映维护后的升级结果', () => {
  let installed = '2.140.0';
  const service = createCodeBuddyVersionService({
    readInstalledVersion: () => installed,
    fetchLatestVersion: async () => '2.141.0',
    now: () => 1,
  });
  assert.equal(service.getSnapshot().installedVersion, '2.140.0');
  installed = '2.141.0';
  assert.equal(service.getSnapshot().installedVersion, '2.141.0');
});

test('CodeBuddy 发布说明来自与版本严格对应的官方 CNB 文档', async () => {
  let requestedUrl = '';
  const markdown = '# 🚀 CodeBuddy Code v2.142.0 发布\n\n## 🐛 问题修复\n- **会话恢复**：恢复历史会话。';
  const encoded = Buffer.from(markdown, 'utf8').toString('base64');
  const release = await fetchCodeBuddyRelease('2.142.0', async (input) => {
    requestedUrl = String(input);
    return new Response(`<script id="__NEXT_DATA__">{"encoding":"base64","content":"${encoded}"}</script>`, { status: 200 });
  });
  assert.deepEqual(release, { body: markdown, publishedAt: null, sourceStatus: 'available' });
  assert.equal(requestedUrl, 'https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/release-notes/v2.142.0.md');
  await assert.rejects(() => fetchCodeBuddyRelease('../2.142.0', async () => new Response('', { status: 200 })), /invalid CodeBuddy release version/);
});

test('CodeBuddy 独立说明缺失但 CHANGELOG 有版本记录时标记仅元数据', async () => {
  const changelog = '# 更新日志\n\n## [2.142.1] - 2026-08-31\n\n- 完整变更记录';
  const encoded = Buffer.from(changelog, 'utf8').toString('base64');
  const urls: string[] = [];
  const release = await fetchCodeBuddyRelease('2.142.1', async (input) => {
    urls.push(String(input));
    return urls.length === 1
      ? new Response('', { status: 404 })
      : new Response(`{"encoding":"base64","content":"${encoded}"}`, { status: 200 });
  });
  assert.deepEqual(release, { body: '', publishedAt: null, sourceStatus: 'metadata_only' });
  assert.match(urls[1] || '', /\/blob\/main\/CHANGELOG\.md$/);
});

test('CodeBuddy 官方页面和解码正文超过上限时失败关闭', async () => {
  const oversizedHtml = 'x'.repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(
    () => fetchCodeBuddyRelease('2.142.0', async () => new Response(oversizedHtml, { status: 200 })),
    /exceeds size limit/,
  );
  const oversizedMarkdown = Buffer.alloc(512 * 1024 + 1, 97).toString('base64');
  await assert.rejects(
    () => fetchCodeBuddyRelease('2.142.0', async () => new Response(`{"encoding":"base64","content":"${oversizedMarkdown}"}`, { status: 200 })),
    /exceeds size limit/,
  );
});

test('CodeBuddy 存在新版时读取结构化说明并保留精确官方入口', async () => {
  const service = createCodeBuddyVersionService({
    readInstalledVersion: () => '2.141.0',
    fetchLatestVersion: async () => '2.142.0',
    fetchRelease: async () => ({
      body: '## ✨ 新功能\n### 本地模型运行支持\n支持本地模型下载。\n## 🔧 改进优化\n### 插件启动与管理\n插件支持重载。\n## 🐛 问题修复\n- **上下文恢复**：修复恢复空转。',
      publishedAt: null,
      sourceStatus: 'available',
    }),
    now: () => 10,
  });
  const snapshot = await service.checkLatest();
  assert.deepEqual(snapshot.releaseOverview, {
    sourceStatus: 'available',
    counts: { features: 1, improvements: 1, fixes: 1, documentation: 0, chores: 0 },
    topics: ['models_providers', 'plugins_skills', 'tasks_sessions'],
    officialSource: 'codebuddy_cnb',
    officialUrl: 'https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/release-notes/v2.142.0.md',
  });
  assert.equal(snapshot.releasePublishedAt, null);
});

test('CodeBuddy 仅有 CHANGELOG 时向面板投影 metadata_only', async () => {
  const service = createCodeBuddyVersionService({
    readInstalledVersion: () => '2.142.0',
    fetchLatestVersion: async () => '2.142.1',
    fetchRelease: async () => ({ body: '', publishedAt: null, sourceStatus: 'metadata_only' }),
    now: () => 15,
  });
  const snapshot = await service.checkLatest();
  assert.equal(snapshot.releaseOverview?.sourceStatus, 'metadata_only');
  assert.deepEqual(snapshot.releaseOverview?.counts, { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 });
});

test('CodeBuddy 说明请求失败时不影响版本检查并标记说明不可用', async () => {
  const service = createCodeBuddyVersionService({
    readInstalledVersion: () => '2.141.0',
    fetchLatestVersion: async () => '2.142.0',
    fetchRelease: async () => { throw new Error('CNB unavailable'); },
    now: () => 20,
  });
  const snapshot = await service.checkLatest();
  assert.equal(snapshot.status, 'success');
  assert.deepEqual(snapshot.releaseOverview, {
    sourceStatus: 'unavailable',
    counts: { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 },
    topics: [],
    officialSource: 'codebuddy_cnb',
    officialUrl: 'https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/release-notes/v2.142.0.md',
  });
});
