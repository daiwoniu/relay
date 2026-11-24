import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { createFieldDefinitionReader, FeishuProjectClient } from './client.js';
import { definitionSchemas, FeishuDefinitionCache } from './definition-cache.js';
import { withFeishuReadBatch } from './read-batch.js';

const config = { connectionId: 'test', projectKey: 'test', userKey: 'me',
  pluginId: 'test', pluginSecret: 'fixture-secret', scope: 'test-scope' };

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await wait(15);
  }
  assert.fail('cache update did not complete');
}

test('warm definitions survive a new client and only missing names or definitions go to Feishu', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-feishu-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'definitions.json');
  const requests: string[] = [];
  let revision = 0;
  const transport: typeof fetch = async (url, options) => {
    const route = new URL(String(url)).pathname;
    requests.push(route);
    if (route.endsWith('/plugin_token')) return Response.json({ data: { token: 'fixture-token' } });
    if (route.endsWith('/all-types')) return Response.json({ data: [{ type_key: 'issue', name: '缺陷', extra: 'private-raw' }] });
    if (route.endsWith('/projects/detail')) return Response.json({ data: { test: { simple_name: 'test', extra: 'private-raw' } } });
    if (route.endsWith('/meta')) return Response.json({ data: [{ field_key: revision ? 'replacement' : 'first', field_name: '首字段' },
      ...(revision ? [{ field_key: 'next', field_name: '新字段' }] : [])] });
    if (route.includes('/flow_roles/')) return Response.json({ data: revision ? [{ id: 'next', name: '新角色',
      is_owner: false, members: ['private-raw'] }] : [] });
    if (route.endsWith('/user/query')) {
      const keys: string[] = JSON.parse(String(options?.body)).user_keys;
      assert.deepEqual(keys, revision ? ['new'] : ['me']);
      return Response.json({ data: keys.map(key => ({ user_key: key, name: key, extra: 'private-raw' })) });
    }
    if (route.endsWith('/filter')) return Response.json({ data: [], pagination: { total: 0 } });
    throw new Error('unexpected fixture request');
  };
  const connect = (scope = config.scope) =>
    new FeishuProjectClient(config, transport, Date.now, 0, new FeishuDefinitionCache(filename, scope));
  const cold = connect();
  await Promise.all([cold.catalog(), cold.space(), cold.metadata('issue'), cold.flowRoles('issue'), cold.users(['me'])]);
  await until(() => fs.existsSync(filename));
  const saved = fs.readFileSync(filename, 'utf8');
  assert.doesNotMatch(saved, /private-raw|fixture-secret|fixture-token/);

  requests.length = 0;
  const warm = connect();
  const stableReads = () => Promise.all([warm.catalog(), warm.space(), warm.metadata('issue'), warm.flowRoles('issue'), warm.users(['me'])]);
  await stableReads();
  assert.equal(requests.length, 0);
  assert.deepEqual(await warm.flowRoles('issue'), []);
  await withFeishuReadBatch(() => warm.candidates(['issue']));
  await withFeishuReadBatch(() => warm.candidates(['issue']));
  assert.equal(requests.filter(route => route.endsWith('/filter')).length, 2);

  revision++;
  const fields = createFieldDefinitionReader(warm, () => '首字段');
  const changedItemFields = [{ field_key: 'replacement' }];
  assert.equal((await fields.find('issue', '首字段', changedItemFields))?.field_key, 'replacement');
  assert.equal((await fields.find('issue', '首字段', changedItemFields))?.field_key, 'replacement');
  assert.equal((await warm.metadata('issue', '新字段')).length, 2);
  assert.equal(requests.filter(route => route.endsWith('/meta')).length, 1);
  const [roles, concurrentRoles] = await Promise.all([warm.flowRoles('issue', ['next']), warm.flowRoles('issue', ['next'])]);
  assert.equal(roles[0].name, '新角色');
  assert.deepEqual(concurrentRoles, roles);
  assert.deepEqual([...await warm.users(['me', 'new'])], [['me', 'me'], ['new', 'new']]);
  await until(() => fs.readFileSync(filename, 'utf8').includes('新角色'));
  assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /private-raw/);
  const before = requests.filter(route => route.endsWith('/all-types')).length;
  await connect('other-scope').catalog();
  assert.equal(requests.filter(route => route.endsWith('/all-types')).length, before + 1);
  await until(() => fs.readFileSync(filename, 'utf8').includes('other-scope'));
});

test('a full cache keeps writing recent entries and restores them after restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-feishu-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'definitions.json');
  const cache = new FeishuDefinitionCache(filename, config.scope);
  const largeValue = 'a'.repeat(800_000);
  for (const key of ['old', 'newer', 'latest']) cache.remember(key, definitionSchemas.name, largeValue);
  await until(() => fs.existsSync(filename));
  const reopened = new FeishuDefinitionCache(filename, config.scope);
  assert.equal(reopened.get('old', definitionSchemas.name), undefined);
  assert.equal(reopened.get('newer', definitionSchemas.name)?.value.length, largeValue.length);
  assert.equal(reopened.get('latest', definitionSchemas.name)?.value.length, largeValue.length);
});

test('older definitions return immediately and prefetch waits for an idle connection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-feishu-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'definitions.json');
  let now = Date.now(), idle = false, reads = 0;
  const cache = new FeishuDefinitionCache(filename, config.scope, () => now, 5);
  const transport: typeof fetch = async url => {
    if (String(url).endsWith('/plugin_token')) return Response.json({ data: { token: 'fixture-token' } });
    reads++;
    return Response.json({ data: [{ type_key: 'issue', name: reads === 1 ? '旧名称' : '新名称' }] });
  };
  const client = new FeishuProjectClient(config, transport, () => now, 0, cache);
  const schema = definitionSchemas.catalog;
  const load = async () => (await new FeishuProjectClient(config, transport, () => now, 0).catalog());
  await client.catalog();
  await until(() => fs.existsSync(filename));
  now += 24 * 60 * 60 * 1000;
  assert.equal((await cache.read('catalog', schema, load, () => idle))[0].name, '旧名称');
  await wait(35);
  assert.equal(reads, 1);
  idle = true;
  await until(() => cache.get('catalog', schema)?.value[0].name === '新名称');
  await until(() => fs.readFileSync(filename, 'utf8').includes('新名称'));
  assert.equal((await client.catalog())[0].name, '新名称');
});
