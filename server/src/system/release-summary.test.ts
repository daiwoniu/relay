import assert from 'node:assert/strict';
import test from 'node:test';
import { extractReleaseOverview } from './release-summary.js';

test('标准版本统计官方章节并按用户影响归纳主题', () => {
  assert.deepEqual(extractReleaseOverview(`
## New Features
- Added configurable startup grace for optional MCP servers. (#41199)
- Extensions can process MCP tool results. (#41202)
- Plugin catalogs honor repository marketplaces. (#41208)
## Bug Fixes
- Preserved permission profiles and sandbox restrictions. (#41192)
- Kept model tools correct during reasoning fallback. (#41195)
- Counted nested subagent usage toward root goals. (#41183)
## Documentation
- Updated the guide. (#1)
## Chores
- Stabilized CI fixtures. (#2)
  `), {
    sourceStatus: 'available',
    counts: { features: 3, improvements: 0, fixes: 3, documentation: 1, chores: 1 },
    topics: ['permissions_security', 'mcp_extensions', 'plugins_skills'],
  });
});

test('单修复版本只保留实际数量和安全权限主题', () => {
  assert.deepEqual(extractReleaseOverview(`
## Bug Fixes
- Apply safer automatic-review defaults and explain permission changes. (#37057)
  `), {
    sourceStatus: 'available',
    counts: { features: 0, improvements: 0, fixes: 1, documentation: 0, chores: 0 },
    topics: ['permissions_security'],
  });
});

test('上下文压缩修复不会误归为连接稳定性', () => {
  assert.deepEqual(extractReleaseOverview(`
## Bug Fixes
- Remote compaction now counts retained images toward its token budget by default, trimming older images as needed. (#41003)
  `), {
    sourceStatus: 'available',
    counts: { features: 0, improvements: 0, fixes: 1, documentation: 0, chores: 0 },
    topics: ['context_compaction'],
  });
});

test('识别官方说明中的复数名词和常见状态词形', () => {
  const emptyCounts = { features: 1, improvements: 0, fixes: 0, documentation: 0, chores: 0 };
  assert.deepEqual(extractReleaseOverview('## New Features\n- Discover executor-provided skills and securely read their resources.'), {
    sourceStatus: 'available',
    counts: emptyCounts,
    topics: ['plugins_skills'],
  });
  assert.deepEqual(extractReleaseOverview('## New Features\n- Improve compatibility for Amazon Bedrock models and external providers.'), {
    sourceStatus: 'available',
    counts: emptyCounts,
    topics: ['models_providers'],
  });
  assert.deepEqual(extractReleaseOverview('## New Features\n- Queued messages resumed archived sessions after connections recovered.'), {
    sourceStatus: 'available',
    counts: emptyCounts,
    topics: ['tasks_sessions', 'connection_stability'],
  });
  assert.deepEqual(extractReleaseOverview('## Bug Fixes\n- Prevent a crash during startup.'), {
    sourceStatus: 'available',
    counts: { features: 0, improvements: 0, fixes: 1, documentation: 0, chores: 0 },
    topics: ['connection_stability'],
  });
});

test('区分仅完整 Changelog、未知正文和空正文', () => {
  const emptyCounts = { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 };
  assert.deepEqual(extractReleaseOverview('## Changelog\n\nFull Changelog: rust-v0.149.0...rust-v0.149.1'), {
    sourceStatus: 'metadata_only',
    counts: emptyCounts,
    topics: [],
  });
  assert.deepEqual(extractReleaseOverview('A release note format Relay does not recognize.'), {
    sourceStatus: 'unrecognized',
    counts: emptyCounts,
    topics: [],
  });
  assert.deepEqual(extractReleaseOverview(''), {
    sourceStatus: 'unrecognized',
    counts: emptyCounts,
    topics: [],
  });
});

test('忽略 Changelog commit 噪声，Chores 仅以高影响主题参与概览', () => {
  assert.deepEqual(extractReleaseOverview(`
## Chores
- Sign and notarize bundled macOS helper executables before packaging. (#35264)
- Reduce serialization allocations. (#34761)
## Changelog
- Add unrelated MCP internal test @copyberry
  `), {
    sourceStatus: 'available',
    counts: { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 2 },
    topics: ['permissions_security', 'windows_cross_platform'],
  });
});
