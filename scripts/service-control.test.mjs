import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  parseSsListeningPids,
  parseWindowsNetstat,
  stopPidTreeByPid,
  stopServicesByPorts,
  waitForPortsReleased,
  isCodexListenerPid,
  stopRemainingCodexListeners,
  pidExists,
} from './lib/service-control.mjs';

test('只有 ESRCH 可确认进程消失，权限和未知检查错误均保守视为存活', () => {
  for (const code of ['EPERM', 'EACCES', 'UNKNOWN', undefined]) {
    assert.equal(pidExists(42, () => { throw Object.assign(new Error('inspection failed'), { code }); }), true);
  }
  assert.equal(pidExists(42, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }), false);
  assert.equal(pidExists(42, () => {}), true);
});

test('包装进程退出后仍可清理真实Codex监听者，不误杀其他进程',async()=>{
  const killed=[];
  await stopRemainingCodexListeners(9281,{platform:'win32',findListeningPidsFn:()=>new Map([[9281,[42,43]]]),
    isCodexListenerPidFn:pid=>pid===42,stopPidTreeByPidFn:async pid=>killed.push(pid)});
  assert.deepEqual(killed,[42]);
});

test('只将准确匹配PID的codex.exe识别为可强制清理的Codex监听者', () => {
  const options={platform:'win32',spawnSyncFn:()=>({status:0,stdout:'"codex.exe","1234","Console","1","10 K"'})};
  assert.equal(isCodexListenerPid(1234,options),true);
  assert.equal(isCodexListenerPid(4321,options),false);
  assert.equal(isCodexListenerPid(1234,{...options,spawnSyncFn:()=>({status:0,stdout:'"other.exe","1234","Console"'})}),false);
});

test('只有Codex幽灵端口可绕过，活进程与其他服务端口继续阻止停止完成', async () => {
  const output=[];
  assert.equal(await stopServicesByPorts([{id:'codex',name:'Codex',port:9281}],{
    platform:'win32',pidExistsFn:()=>false,findListeningPidsFn:()=>new Map([[9281,[42]]]),
    stopPidTreeByPidFn:()=>assert.fail('不得强杀已消失PID或任意其他进程'),write:line=>output.push(line),
  }),0);
  assert.ok(output.some(line=>line.includes('下次启动')));
  await assert.rejects(waitForPortsReleased([9281],{platform:'win32',timeoutMs:1,pollIntervalMs:1,
    allowGhostPorts:[9281],pidExistsFn:()=>true,findListeningPidsFn:()=>new Map([[9281,[42]]])}),/等待端口释放超时/);
});

test('Windows netstat 只识别目标端口的 LISTENING 进程', () => {
  const output = [
    '  TCP    127.0.0.1:9081       0.0.0.0:0       LISTENING       101',
    '  TCP    0.0.0.0:9082         0.0.0.0:0       LISTENING       202',
    '  TCP    192.168.1.2:5000     192.168.1.2:9083 ESTABLISHED     303',
    '  TCP    0.0.0.0:9083         0.0.0.0:0       LISTENING       404',
    '  TCP    127.0.0.1:9081       127.0.0.1:5001   TIME_WAIT       0',
  ].join('\n');
  const result = parseWindowsNetstat(output, [9081, 9082, 9083]);
  assert.deepEqual(result.get(9081), [101]);
  assert.deepEqual(result.get(9082), [202]);
  assert.deepEqual(result.get(9083), [404]);
});

test('ss 输出可解析监听端口与 PID', () => {
  const output = 'LISTEN 0 511 0.0.0.0:9083 0.0.0.0:* users:(("node",pid=404,fd=20))';
  const result = parseSsListeningPids(output, [9081, 9082, 9083]);
  assert.deepEqual(result.get(9083), [404]);
});

test('Windows 按 PID 强制停止进程树', async () => {
  let alive = true;
  const calls = [];
  await stopPidTreeByPid(1234, {
    platform: 'win32',
    directKillGraceTimeoutMs: 0,
    killFn: () => {
      if (!alive) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    },
    spawnSyncFn: (command, args) => {
      calls.push([command, args]);
      alive = false;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls, [['taskkill', ['/PID', '1234', '/T', '/F']]]);
});

test('Windows 不先杀父进程，保留进程树供taskkill完整清理', async () => {
  let alive = true;
  let taskkillCalled = false;
  await stopPidTreeByPid(1357, {
    platform: 'win32',
    killFn: (_pid, signal) => {
      if (!alive) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      if (signal === 'SIGTERM') alive = false;
    },
    spawnSyncFn: () => {
      taskkillCalled = true;
      assert.equal(alive, true);
      alive = false;
      return { status: 0 };
    },
  });
  assert.equal(alive, false);
  assert.equal(taskkillCalled, true);
});

test('Windows 异步 taskkill 在 exit 时立即完成', async () => {
  let alive = true;
  const child = new EventEmitter();
  child.kill = () => {};
  await stopPidTreeByPid(2468, {
    platform: 'win32',
    directKillGraceTimeoutMs: 0,
    killFn: () => {
      if (!alive) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    },
    spawnFn: () => {
      queueMicrotask(() => {
        alive = false;
        child.emit('exit', 0);
      });
      return child;
    },
  });
  assert.equal(alive, false);
});

test('多个服务按反向依赖顺序串行停止', async () => {
  const services = [
    { name: 'Codex', port: 9081 },
    { name: 'Relay 后端', port: 9082 },
    { name: 'Vite 前端', port: 9083 },
  ];
  let active = 0;
  let maxActive = 0;
  let scanCount = 0;
  const stopped = [];
  const exitCode = await stopServicesByPorts(services, {
    write: () => {},
    findListeningPidsFn: (ports) => {
      scanCount += 1;
      return new Map(ports.map((port) => [port, scanCount === 1 ? [port] : []]));
    },
    stopPidTreeByPidFn: async (pid) => {
      stopped.push(pid);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    },
    timeoutMs: 50,
    pollIntervalMs: 1,
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(stopped, [9083, 9082, 9081]);
  assert.equal(maxActive, 1);
});

test('停止命令先停 Codex，再停前端，最后停后端并等待端口释放', async () => {
  const services = [
    { name: 'Relay 后端', port: 9082 },
    { name: 'Vite 前端', port: 9083 },
    { name: 'Codex', port: 9081 },
  ];
  let scanCount = 0;
  const stopped = [];
  const output = [];
  const exitCode = await stopServicesByPorts(services, {
    write: (line) => output.push(line),
    findListeningPidsFn: (ports) => {
      scanCount += 1;
      return new Map(ports.map((port) => [port, scanCount === 1 ? [port] : []]));
    },
    stopPidTreeByPidFn: async (pid) => stopped.push(pid),
    timeoutMs: 100,
    pollIntervalMs: 1,
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(stopped, [9081, 9083, 9082]);
  assert.equal(output[1], '');
  assert.match(output.at(-2), /受管服务均已退出/);
  assert.equal(output.at(-1), '');
});

test('没有服务运行时说明无需停止', async () => {
  const services = [
    { name: 'Codex', port: 9081 },
    { name: 'Relay 后端', port: 9082 },
    { name: 'Vite 前端', port: 9083 },
  ];
  const output = [];
  const exitCode = await stopServicesByPorts(services, {
    write: (line) => output.push(line),
    findListeningPidsFn: (ports) => new Map(ports.map((port) => [port, []])),
  });
  assert.equal(exitCode, 0);
  assert.equal(output.at(-2), '未检测到正在运行的服务，无需停止。');
  assert.equal(output.at(-1), '');
  assert.equal(output.some((line) => line.includes('停止完成')), false);
});

test('停止失败时仍以空行结束输出', async () => {
  const services = [{ name: 'Codex', port: 9081 }];
  const output = [];
  const exitCode = await stopServicesByPorts(services, {
    write: (line) => output.push(line),
    findListeningPidsFn: () => new Map([[9081, [1234]]]),
    stopPidTreeByPidFn: async () => { throw new Error('拒绝访问'); },
  });
  assert.equal(exitCode, 1);
  assert.ok(output.some((line) => line.includes('停止失败：拒绝访问')));
  assert.equal(output.at(-1), '');
});

test('端口释放超时只报告实际残留端口并识别幽灵 PID', async () => {
  await assert.rejects(
    waitForPortsReleased([9081, 9082, 9083], {
      timeoutMs: 3,
      pollIntervalMs: 1,
      findListeningPidsFn: () => new Map([[9081, [12916]], [9082, []], [9083, []]]),
      pidExistsFn: () => false,
    }),
    (error) => {
      assert.match(error.message, /9081/);
      assert.doesNotMatch(error.message, /9082|9083/);
      assert.match(error.message, /PID 12916 已不存在/);
      assert.match(error.message, /Windows 幽灵监听/);
      return true;
    },
  );
});
