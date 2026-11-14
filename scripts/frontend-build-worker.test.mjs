import assert from 'node:assert/strict';
import test from 'node:test';
import { runFrontendBuildWorker } from './frontend-build-worker.mjs';

test('固定前端构建 worker 只回传严格构建结果', () => {
  const sent = [], output = [], toolOutput=[];
  const result = runFrontendBuildWorker({
    root: 'G:\\AI\\relay',
    prepare: ({onProgress,onOutput}) => {onProgress('正在打包前端界面，请稍候...');onOutput('stdout','build details\n');return { buildId: 'abcdef123456', buildLabel: '20260829-0935 · abcdef1', reused: false };},
    write: line => output.push(line),
    onOutput:(channel,chunk)=>toolOutput.push([channel,chunk]),
    send: (message) => sent.push(message),
  });
  assert.equal(result, 0);
  assert.deepEqual(output,['正在打包前端界面，请稍候...']);
  assert.deepEqual(toolOutput,[['stdout','build details\n']]);
  assert.deepEqual(sent, [{ channel: 'relay-frontend-build-worker-v1', type: 'result', status: 'completed', buildId: 'abcdef123456', buildLabel: '20260829-0935 · abcdef1', reused: false, message: null }]);
});

test('固定前端构建 worker 失败时返回受限消息且不接受命令参数', () => {
  const sent = [], output=[];
  const result = runFrontendBuildWorker({
    root: 'G:\\AI\\relay',
    prepare: ({onOutput}) => {onOutput('stderr','failed tool details\n');throw new Error(`失败\n${'x'.repeat(9000)}`); },
    onOutput:(channel,chunk)=>output.push([channel,chunk]),
    send: (message) => sent.push(message),
  });
  assert.equal(result, 1);
  assert.deepEqual(output,[['stderr','failed tool details\n']]);
  assert.equal(sent[0].status, 'failed');
  assert.equal(sent[0].message.includes('\n'), false);
  assert.ok(sent[0].message.length <= 8000);
  assert.equal(Object.hasOwn(sent[0], 'command'), false);
  assert.equal(Object.hasOwn(sent[0], 'args'), false);
  assert.equal(Object.hasOwn(sent[0], 'root'), false);
});
