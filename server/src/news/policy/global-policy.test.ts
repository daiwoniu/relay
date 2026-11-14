import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesGlobalBlock, validateSourceConfig } from './global-policy.js';

const item = { id: '1', url: 'https://example.com/a', title: 'New AI model', description: null, sourceId: 'example' };

test('global deny rules match old and new items without rewriting shards', () => {
  assert.equal(matchesGlobalBlock(item, { blockedDomains: ['example.com'], blockedKeywords: [], blockedUrls: [] }), 'domain:example.com');
  assert.equal(matchesGlobalBlock(item, { blockedDomains: [], blockedKeywords: ['model'], blockedUrls: [] }), 'keyword:model');
  assert.equal(matchesGlobalBlock(item, { blockedDomains: [], blockedKeywords: [], blockedUrls: ['https://example.com/a'] }), 'url');
  assert.equal(matchesGlobalBlock(item, { blockedDomains: [], blockedKeywords: [], blockedUrls: [] }), null);
});

test('source configuration rejects internal targets and unsupported adapters', () => {
  const base = { id: 'new', name: 'New', kind: 'rss_atom', url: 'https://example.com/feed', allowedHosts: ['example.com'], enabled: true, intervalMinutes: 30, categoryId: 'research' };
  assert.equal(validateSourceConfig(base).id, 'new');
  for (const url of ['http://example.com/feed', 'https://127.0.0.1/feed', 'https://localhost/feed', 'https://example.com:8443/feed', 'https://u:p@example.com/feed']) {
    assert.throws(() => validateSourceConfig({ ...base, url }), url);
  }
  assert.throws(() => validateSourceConfig({ ...base, kind: 'browser' }));
});
