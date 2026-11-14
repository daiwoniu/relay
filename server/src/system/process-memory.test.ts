import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWindowsProcessMemory, summarizeProcessMemory, type ProcessMemoryRow } from './process-memory.js';

const row = (pid: number, parentPid: number, name: string, privateBytes: number): ProcessMemoryRow => ({ pid, parentPid, name, privateBytes, startedAt: pid });

test('按父子关系统计Relay整棵服务树，不误算同名的外部Node和Codex', () => {
  const result = summarizeProcessMemory([
    row(1, 0, 'pwsh.exe', 99), row(2, 1, 'node.exe', 10),
    row(3, 2, 'node.exe', 30), row(4, 2, 'node.exe', 20),
    row(5, 2, 'codex.exe', 50), row(6, 5, 'node.exe', 40),
    row(7, 1, 'codex.exe', 100), row(8, 1, 'node.exe', 200),
  ], 3, 2);
  assert.deepEqual(result.relay, { privateBytes: 150, backendPrivateBytes: 30, processCount: 5, scope: 'managed' });
  assert.deepEqual(result.topProcesses[0], { name: 'node.exe', privateBytes: 300, processCount: 5 });
  assert.doesNotMatch(JSON.stringify(result), /pid|parent|command|path/i);
});

test('未受管或父进程不匹配时仅统计后端树，后端消失时不伪报零占用', () => {
  const rows = [row(1, 0, 'shell.exe', 100), row(2, 1, 'node.exe', 20), row(3, 2, 'tool.exe', 30)];
  for (const root of [undefined, 999]) {
    assert.deepEqual(summarizeProcessMemory(rows, 2, root).relay, {
      privateBytes: 50, backendPrivateBytes: 20, processCount: 2, scope: 'backend',
    });
  }
  assert.equal(summarizeProcessMemory(rows, 999).relay, null);
});

test('榜单合并大小写同名进程、按私有提交量降序且最多五项', () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(i + 1, 0, `app${i}.exe`, i * 10));
  rows.push(row(10, 0, 'APP1.EXE', 100));
  const result = summarizeProcessMemory(rows, 1);
  assert.equal(result.topProcesses.length, 5);
  assert.deepEqual(result.topProcesses[0], { name: 'app1.exe', privateBytes: 110, processCount: 2 });
  assert.equal(result.topProcesses.at(-1)?.privateBytes, 30);
});

test('Windows输出支持BOM及单行对象，拒绝损坏数值和路径', () => {
  const entry = row(1, 0, '中文.exe', 1024);
  assert.deepEqual(parseWindowsProcessMemory(`\uFEFF${JSON.stringify(entry)}`), [entry]);
  for (const value of [[], null, { ...entry, privateBytes: -1 }, { ...entry, privateBytes: null }, { ...entry, startedAt: null }, { ...entry, name: 'C:\\secret.exe' }]) {
    assert.throws(() => parseWindowsProcessMemory(JSON.stringify(value)));
  }
});

test('PID被复用时排除早于父进程创建的旧子进程，逆序输入仍可追溯多级后代', () => {
  const rows = [row(1, 0, 'node.exe', 10), row(2, 1, 'node.exe', 20), row(3, 2, 'codex.exe', 30)];
  rows.push({ ...row(4, 1, 'external.exe', 500), startedAt: rows[0].startedAt - 1 });
  assert.equal(summarizeProcessMemory(rows.reverse(), 2, 1).relay?.privateBytes, 60);
  const newerRoot = { ...row(1, 0, 'shell.exe', 999), startedAt: 10 };
  assert.equal(summarizeProcessMemory([newerRoot, row(2, 1, 'node.exe', 20)], 2, 1).relay?.scope, 'backend');
});
