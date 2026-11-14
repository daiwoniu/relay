import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { safeFetch, type SafeFetchDependencies } from './safe-fetch.js';

function fakeDependencies(responses: Array<{ status: number; location?: string; body?: string }>): SafeFetchDependencies & { visited: string[] } {
  const visited: string[] = [];
  return {
    visited,
    resolve: async (hostname) => hostname === 'private.example' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.215.14', family: 4 }],
    request: async (url, address) => {
      assert.equal(address, '93.184.215.14');
      visited.push(url.href);
      const next = responses.shift() ?? { status: 200, body: '' };
      return { status: next.status, headers: { location: next.location ?? null, etag: null, 'last-modified': null, 'retry-after': null }, body: Buffer.from(next.body ?? '') };
    },
  };
}

test('非法协议和私网目标在请求前被拒绝', async () => {
  const deps = fakeDependencies([]);
  await assert.rejects(safeFetch('file:///etc/passwd', { allowedHosts: ['example.org'] }, deps), /协议/);
  await assert.rejects(safeFetch('https://example.org:8443/feed', { allowedHosts: ['example.org'] }, deps), /端口/);
  await assert.rejects(safeFetch('https://127.0.0.1/private', { allowedHosts: ['127.0.0.1'] }, deps), /公网/);
  await assert.rejects(safeFetch('https://private.example/feed', { allowedHosts: ['private.example'] }, deps), /公网/);
  assert.equal(deps.visited.length, 0);
});

test('每次重定向重新校验 DNS 和允许域名', async () => {
  const deps = fakeDependencies([{ status: 302, location: 'https://private.example/inside' }]);
  await assert.rejects(safeFetch('https://example.org/feed', { allowedHosts: ['example.org', 'private.example'] }, deps), /公网/);
  assert.deepEqual(deps.visited, ['https://example.org/feed']);
});

test('响应超过 2 MiB 和条件请求 304 分别处理', async () => {
  const large = fakeDependencies([{ status: 200, body: 'x'.repeat(2 * 1024 * 1024 + 1) }]);
  await assert.rejects(safeFetch('https://example.org/feed', { allowedHosts: ['example.org'] }, large), /2 MiB/);
  const unchanged = fakeDependencies([{ status: 304 }]);
  const result = await safeFetch('https://example.org/feed', { allowedHosts: ['example.org'], etag: 'last' }, unchanged);
  assert.equal(result.status, 304);
  assert.equal(result.body.length, 0);
});

test('服务端返回 gzip 时先有界解压再交给 XML 解析器', async () => {
  const xml = '<rss><channel><item><title>AI</title></item></channel></rss>';
  const dependencies = fakeDependencies([]);
  dependencies.request = async () => ({
    status: 200, headers: { location: null, etag: null, 'last-modified': null, 'retry-after': null, 'content-encoding': 'gzip' },
    body: gzipSync(Buffer.from(xml)),
  });
  const response = await safeFetch('https://example.org/feed', { allowedHosts: ['example.org'] }, dependencies);
  assert.equal(response.body.toString('utf8'), xml);
});

test('HTTPS 域名经本机 TUN 解析到 198.18 测试网段仍可抓取', async () => {
  const dependencies = fakeDependencies([{ status: 200, body: '<rss />' }]);
  dependencies.resolve = async () => [{ address: '198.18.1.37', family: 4 }];
  dependencies.request = async (_url, address) => {
    assert.equal(address, '198.18.1.37');
    return { status: 200, headers: { location: null }, body: Buffer.from('<rss />') };
  };
  const response = await safeFetch('https://example.org/feed', { allowedHosts: ['example.org'] }, dependencies);
  assert.equal(response.status, 200);
  await assert.rejects(safeFetch('https://198.18.1.37/feed', { allowedHosts: ['198.18.1.37'] }, dependencies), /公网/);
});
