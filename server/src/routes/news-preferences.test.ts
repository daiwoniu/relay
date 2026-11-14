import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewsPreferencesRouter } from './news-preferences.js';

test('preferences use authenticated actor ID and reject cross-site writes', async () => {
  let userId = 'a';
  const values = new Map<string, unknown>();
  const repo = {
    getStatus: () => ({ available: true, version: 0, lastSuccessAt: null, loadedShards: [] }),
    getUserPreferences: (id: string) => values.get(id) ?? { rules: [] },
    saveUserPreferences: (id: string, value: unknown) => { values.set(id, value); },
  };
  const router = createNewsPreferencesRouter({ repository: () => repo as never, getActor: () => ({ userId, role: 'member' }), originAllowed: (origin) => !origin || origin === 'https://relay.example' });
  const body = JSON.stringify({ rules: [{ id: 'x', kind: 'follow', topic: 'agent' }] });
  assert.equal((await router.request('/preferences', { method: 'PUT', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body })).status, 403);
  assert.equal((await router.request('/preferences', { method: 'PUT', headers: { origin: 'https://relay.example', 'content-type': 'application/json' }, body })).status, 200);
  assert.equal(values.has('a'), true);
  userId = 'b';
  const result = await (await router.request('/preferences')).json();
  assert.deepEqual(result, { rules: [] });
  assert.equal((await router.request('/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'a', rules: [] }) })).status, 400);
});

test('member feed applies global deny, personal mute and follow in order', async () => {
  let userId = 'a';
  let blocked = false;
  const item = { id: 'item', eventId: 'event', sourceId: 'source', url: 'https://example.com/post', title: 'AI agent release', description: null, publishedAt: 1_999_999_999_000, firstFetchedAt: 1_999_999_999_000, categoryId: 'research', topicIds: ['agent'], entityIds: ['openai'], eventTypeId: 'release', language: 'en' };
  const preferences = new Map([
    ['a', { rules: [{ id: 'follow', kind: 'follow', topic: 'agent' }] }],
    ['b', { rules: [{ id: 'mute', kind: 'mute', entity: 'openai' }, { id: 'follow', kind: 'follow', topic: 'agent' }] }],
  ]);
  const repo = {
    getStatus: () => ({ available: true, version: 2, lastSuccessAt: null }),
    getUserPreferences: (id: string) => preferences.get(id) ?? { rules: [] },
    getGlobalPolicy: () => ({ blockedDomains: blocked ? ['example.com'] : [], blockedKeywords: [], blockedUrls: [] }),
    getCorrection: () => null,
    listSources: () => [{ id: 'source', name: 'Source', enabled: true }],
    listCategories: () => [{ id: 'research', label: '研究' }],
    getSourceState: () => null,
    list: async () => ({ items: [{ ...item, sources: [item] }], nextCursor: null, version: 2 }),
  };
  const router = createNewsPreferencesRouter({ repository: () => repo as never, getActor: () => ({ userId, role: 'member' }), now: () => 2_000_000_000_000 });
  let response = await (await router.request('/?view=following')).json();
  assert.equal(response.items.length, 1);
  assert.match(response.items[0].matchReason, /关注/);
  userId = 'b';
  response = await (await router.request('/?view=all')).json();
  assert.equal(response.items.length, 0);
  userId = 'a'; blocked = true;
  response = await (await router.request('/?view=following')).json();
  assert.equal(response.items.length, 0);
});
