import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareCodexVersions,
  createCodexVersionService,
  fetchCodexRelease,
  fetchLatestCodexNpmVersion,
  getCodexVersionCommand,
  extractCodexVersion,
} from './codex-version.js';

test('解析 Codex CLI 输出和语义版本', () => {
  assert.equal(extractCodexVersion('codex-cli 0.42.0'), '0.42.0');
  assert.deepEqual(getCodexVersionCommand('win32', 'C:\\Windows\\System32\\cmd.exe'), {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'codex.cmd --version'],
  });
  assert.deepEqual(getCodexVersionCommand('linux'), {
    file: 'codex',
    args: ['--version'],
  });
  assert.equal(extractCodexVersion('rust-v0.43.1'), '0.43.1');
  assert.equal(extractCodexVersion('v1.2.3-beta.1'), '1.2.3-beta.1');
  assert.equal(extractCodexVersion('unknown'), null);
});

test('Codex 最新稳定版来自官方 npm latest 元数据', async () => {
  let requestedUrl = '';
  const version = await fetchLatestCodexNpmVersion(async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 });
  });
  assert.equal(version, '1.2.3');
  assert.match(requestedUrl, /registry\.npmjs\.org\/\@openai%2Fcodex\/latest/);
});

test('Codex 发布说明和发布时间来自与版本严格对应的官方 GitHub release', async () => {
  let requestedUrl = '';
  const release = await fetchCodexRelease('1.2.3', async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ body: '## New Features\n- A complete feature.', published_at: '2026-08-24T00:28:28Z' }), { status: 200 });
  });
  assert.deepEqual(release, {
    body: '## New Features\n- A complete feature.',
    publishedAt: Date.parse('2026-08-24T00:28:28Z'),
  });
  assert.match(requestedUrl, /api\.github\.com\/repos\/openai\/codex\/releases\/tags\/rust-v1\.2\.3$/);

  const invalid = await fetchCodexRelease('1.2.3', async () => new Response(JSON.stringify({ published_at: 'not-a-time' }), { status: 200 }));
  assert.deepEqual(invalid, { body: '', publishedAt: null });
  const nonCanonical = await fetchCodexRelease('1.2.3', async () => new Response(JSON.stringify({ published_at: '2026-08-24T08:28:28+08:00' }), { status: 200 }));
  assert.deepEqual(nonCanonical, { body: '', publishedAt: null });
});

test('语义比较识别新版和预发布版本', () => {
  assert.equal(compareCodexVersions('0.43.0', '0.42.9'), 1);
  assert.equal(compareCodexVersions('0.43.0', '0.43.0'), 0);
  assert.equal(compareCodexVersions('0.43.0-beta.1', '0.43.0'), -1);
});

test('启动读取当前版本，手动检查同时刷新升级后的本地版本', async () => {
  let currentReads = 0;
  let latestChecks = 0;
  const latestVersions = ['0.43.0', '0.44.0'];
  const service = createCodexVersionService({
    readCurrentVersion: () => {
      currentReads += 1;
      return currentReads === 1 ? 'codex-cli 0.42.0' : 'codex-cli 9.9.9';
    },
    fetchLatestVersion: async () => {
      const value = latestVersions[latestChecks];
      latestChecks += 1;
      return value;
    },
    fetchRelease: async () => ({ body: '## New Features\n- Added a clear new workflow. (#123)', publishedAt: 1_777_000_000_000 }),
    now: () => 1234 + latestChecks,
  });

  service.initialize();
  assert.equal(service.getSnapshot().currentVersion, '0.42.0');
  assert.equal(service.getSnapshot().status, 'checking');

  const startup = await service.getReadySnapshot();
  assert.deepEqual(startup, {
    currentVersion: '0.42.0',
    latestVersion: '0.43.0',
    releaseOverview: {
      sourceStatus: 'available',
      counts: { features: 1, improvements: 0, fixes: 0, documentation: 0, chores: 0 },
      topics: [],
      officialSource: 'codex_github',
      officialUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.43.0',
    },
    releasePublishedAt: 1_777_000_000_000,
    updateAvailable: true,
    status: 'success',
    checkedAt: 1235,
  });

  const manual = await service.checkLatest();
  assert.equal(manual.currentVersion, '9.9.9');
  assert.equal(manual.latestVersion, '0.44.0');
  assert.equal(currentReads, 2);
  assert.equal(latestChecks, 2);
});

test('并发检查复用请求，失败时保留当前版本并安全降级', async () => {
  let resolveLatest!: (version: string) => void;
  let calls = 0;
  const service = createCodexVersionService({
    readCurrentVersion: () => 'codex-cli 0.42.0',
    fetchLatestVersion: () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        resolveLatest = resolve;
      });
    },
    fetchRelease: async () => { throw new Error('release offline'); },
    now: () => 2000,
  });

  service.initialize();
  const first = service.getReadySnapshot();
  const second = service.checkLatest();
  assert.equal(calls, 1);
  resolveLatest('0.42.0');
  assert.equal((await first).updateAvailable, false);
  assert.equal((await second).status, 'success');

  const failed = createCodexVersionService({
    readCurrentVersion: () => 'codex-cli 0.42.0',
    fetchLatestVersion: async () => {
      throw new Error('offline');
    },
    now: () => 3000,
  });
  failed.initialize();
  assert.deepEqual(await failed.getReadySnapshot(), {
    currentVersion: '0.42.0',
    latestVersion: null,
    releaseOverview: null,
    releasePublishedAt: null,
    updateAvailable: null,
    status: 'error',
    checkedAt: 3000,
  });
});

test('版本可升级但发布正文请求失败时保留精确官方入口并标记不可用', async () => {
  const service = createCodexVersionService({
    readCurrentVersion: () => 'codex-cli 0.42.0',
    fetchLatestVersion: async () => '0.43.0',
    fetchRelease: async () => { throw new Error('release offline'); },
    now: () => 4000,
  });
  const snapshot = await service.getReadySnapshot();
  assert.deepEqual(snapshot.releaseOverview, {
    sourceStatus: 'unavailable',
    counts: { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 },
    topics: [],
    officialSource: 'codex_github',
    officialUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.43.0',
  });
});
