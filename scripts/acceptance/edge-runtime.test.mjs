import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildEdgeArguments, buildEdgeSpawnOptions, createRunId, createRunPaths, parseDevToolsActivePort } from './lib/edge-runtime.mjs';

test('run ID 不可预测且只使用安全字符', () => {
  const first = createRunId();
  const second = createRunId();
  assert.match(first, /^[a-z0-9-]{20,80}$/u);
  assert.notEqual(first, second);
});

test('运行路径固定在 acceptance run ID 下', () => {
  const paths = createRunPaths('run-0123456789abcdef');
  assert.equal(path.basename(paths.runDir), 'run-0123456789abcdef');
  assert.equal(paths.profileDir, path.join(paths.runDir, 'profile'));
  assert.throws(() => createRunPaths('../outside'), /run ID/);
});

test('Edge 参数固定使用 headless、随机端口和唯一 profile', () => {
  const profileDir = 'G:\\AI\\relay\\.relay-dev\\acceptance\\run-0123456789abcdef\\profile';
  const args = buildEdgeArguments({ profileDir, origin: 'http://localhost:9081' });
  for (const expected of ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-extensions']) {
    assert.ok(args.includes(expected), expected);
  }
  assert.equal(args.some((arg) => /Default|User Data(?!-dir)/iu.test(arg)), false);
  assert.equal(args.includes('http://localhost:9081'), false);
  assert.equal(args.at(-1), 'about:blank');
  assert.deepEqual(buildEdgeSpawnOptions(), { windowsHide: true, shell: false, detached: false, stdio: 'ignore' });
});

test('DevToolsActivePort 只接受本机随机端口和 browser websocket 路径', () => {
  assert.deepEqual(parseDevToolsActivePort('43210\n/devtools/browser/id\n'), { port: 43210, webSocketPath: '/devtools/browser/id' });
  for (const value of ['9222', '99999\n/devtools/browser/id', '43210\nhttp://evil']) {
    assert.throws(() => parseDevToolsActivePort(value), /DevToolsActivePort/);
  }
});
