import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Hono } from 'hono';
import { compress } from 'hono/compress';

test('Hono 对超过阈值的 API JSON 返回 gzip', async () => {
  const app = new Hono();
  app.use('/api/*', compress({ threshold: 1024 }));
  app.get('/api/large', (c) => c.json({ content: '重复内容'.repeat(2000) }));
  app.get('/api/small', (c) => {
    c.header('Content-Length', '11');
    return c.json({ ok: true });
  });

  const large = await app.request('/api/large', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(large.headers.get('Content-Encoding'), 'gzip');
  const small = await app.request('/api/small', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(small.headers.get('Content-Encoding'), null);
});

test('正式后端只在 API 路径注册响应压缩', () => {
  const source = fs.readFileSync(new URL('stored-http-application.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ compress \} from 'hono\/compress'/);
  assert.match(source, /app\.use\('\/api\/\*',\s*compress\(\{\s*threshold:\s*1024\s*\}\)\)/);
});
