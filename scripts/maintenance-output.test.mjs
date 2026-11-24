import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceOutputStore } from './lib/maintenance-output.mjs';

test('维护输出按到达顺序合并流并只保留最近两行', () => {
  const store = createMaintenanceOutputStore({ root: 'G:\\AI\\relay', now: () => 100 });
  store.start('op-1');
  store.append('op-1', 'stdout', '第一行');
  store.append('op-1', 'stderr', '错误行\n');
  store.append('op-1', 'stdout', '完成\n第三行\n');

  assert.deepEqual(store.getSnapshot('op-1'), {
    operationId: 'op-1',
    sequence: 4,
    lines: ['第一行完成', '第三行'],
    status: 'running',
    updatedAt: 100,
  });
});

test('维护输出正确处理跨 chunk UTF-8 和 CR 进度覆盖', () => {
  const store = createMaintenanceOutputStore();
  store.start('op-1');
  const bytes = Buffer.from('构建 10%\r构建完成\n');
  store.append('op-1', 'stdout', bytes.subarray(0, 2));
  store.append('op-1', 'stdout', bytes.subarray(2, 8));
  store.append('op-1', 'stdout', bytes.subarray(8));

  assert.deepEqual(store.getSnapshot('op-1')?.lines, ['构建完成']);
  assert.doesNotMatch(store.getSnapshot('op-1')?.lines.join('') || '', /�|10%/);
});

test('维护输出清理 ANSI、秘密、控制字符并投影项目绝对路径', () => {
  const store = createMaintenanceOutputStore({ root: 'G:\\AI\\relay', knownSecrets: ['known-value'] });
  store.start('op-1');
  store.append('op-1', 'stdout', '\u001b[32mG:\\AI\\relay\\.relay-build\\frontend\\dist\\index.html\u001b[0m token=abc known-value\u0000\n');

  const line = store.getSnapshot('op-1')?.lines[0] || '';
  assert.match(line, /^…\/\.relay-build\/frontend\/dist\/index\.html token=\[已隐藏\] \[已隐藏\]$/);
  assert.doesNotMatch(line, /\u001b|\u0000|G:\\AI|abc|known-value/);
});

test('维护输出限制单行长度并且只允许匹配的 operation 读取和写入', () => {
  const store = createMaintenanceOutputStore({ maxLineChars: 20 });
  store.start('op-1');
  store.append('other', 'stdout', '不应出现\n');
  store.appendStage('op-1', '甲'.repeat(30));

  const snapshot = store.getSnapshot('op-1');
  assert.equal(snapshot?.lines.length, 1);
  assert.equal([...snapshot.lines[0]].length, 20);
  assert.match(snapshot.lines[0], /…$/);
  assert.equal(store.getSnapshot('other'), null);
});

test('维护输出终态保留最后两行并返回防御性副本', () => {
  let now = 1;
  const store = createMaintenanceOutputStore({ now: () => now });
  store.start('op-1');
  store.appendStage('op-1', '正在验证');
  now = 2;
  store.finish('op-1', 'completed');

  const snapshot = store.getSnapshot('op-1');
  assert.equal(snapshot?.status, 'completed');
  assert.equal(snapshot?.sequence, 3);
  assert.equal(snapshot?.updatedAt, 2);
  snapshot?.lines.push('篡改');
  assert.deepEqual(store.getSnapshot('op-1')?.lines, ['正在验证']);
});

test('环境修复失败时保留关键诊断，不让通用结束提示覆盖报错', () => {
  const store = createMaintenanceOutputStore();
  store.start('typecheck');
  store.append('typecheck', 'stdout', 'src/upload.test.ts:19:47 - error TS6059: File is not under rootDir\n');
  store.append('typecheck', 'stderr', '✗ 服务端验证失败：npm run typecheck\n建议：\n- 修复后重新执行 npm run setup\n初始化已终止。\n');
  store.appendStage('typecheck', 'Relay 环境修复失败');
  store.finish('typecheck', 'failed');
  assert.deepEqual(store.getSnapshot('typecheck')?.lines, [
    'Relay 环境修复失败',
    'src/upload.test.ts:19:47 - error TS6059: File is not under rootDir',
  ]);

  store.start('network');
  store.append('network', 'stderr', 'npm error code ENOTFOUND\nnpm error network request to registry failed\n');
  store.appendStage('network', 'Relay 环境修复失败');
  store.finish('network', 'failed');
  assert.deepEqual(store.getSnapshot('network')?.lines, [
    'Relay 环境修复失败',
    'npm error network request to registry failed',
  ]);
});
