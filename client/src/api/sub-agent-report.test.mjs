import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const built = buildSync({ stdin: { contents: "export { getSubAgentReport } from './sessions.ts';", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { getSubAgentReport } = compiled.exports;

test('回报请求允许后端三阶段等待，正常完成会清理截止计时器', async t => {
  const originalFetch = globalThis.fetch;
  let respond, signal, url;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = (input, options) => { url = input; signal = options.signal; return new Promise((resolve, reject) => {
    respond = resolve; signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }); };
  try {
    const result = getSubAgentReport('session/a', 'message?', 'subagent-completed-first', new AbortController().signal);
    const captured = result.then(value => ({ value }), error => ({ error }));
    t.mock.timers.tick(30_000);
    assert.equal(signal.aborted, false);
    assert(url.includes('session%2Fa/messages/message%3F/subagent-report?itemId=subagent-completed-first'));
    respond(Response.json({ content: '延迟后正常返回的回报' }));
    assert.deepEqual(await captured, { value: { content: '延迟后正常返回的回报' } });
    t.mock.timers.tick(60_000); assert.equal(signal.aborted, false);
  } finally { globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});

test('加长回报等待不影响主动取消，超过截止时间仍可重试', async t => {
  const originalFetch = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = (_input, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  try {
    const controller = new AbortController();
    const cancelled = getSubAgentReport('s', 'm', 'item', controller.signal);
    controller.abort(); await assert.rejects(cancelled, error => error.name === 'AbortError');
    const expired = getSubAgentReport('s', 'm', 'item', new AbortController().signal);
    const checked = assert.rejects(expired, /请求超时/);
    t.mock.timers.tick(35_000); await checked;
  } finally { globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});
