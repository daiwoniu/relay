import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { pidExists, stopPidTreeByPid, waitForPortsReleased } from './lib/service-control.mjs';

test('Windows隔离进程树停止后，真实子进程监听端口可重新使用', {skip:process.platform!=='win32'||process.env.CODEX_SANDBOX_NETWORK_DISABLED==='1',timeout:12000},async t=>{
  const childCode="const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:s.address().port})));";
  const parentCode=`const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','ignore'],windowsHide:true});c.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
  const parent=spawn(process.execPath,['-e',parentCode],{stdio:['ignore','pipe','ignore'],windowsHide:true});
  let descendant;
  t.after(async()=>{for(const pid of [parent.pid,descendant?.pid])if(pid&&pidExists(pid))await stopPidTreeByPid(pid);});
  const [data]=await once(parent.stdout,'data',{signal:AbortSignal.timeout(5000)});
  descendant=JSON.parse(data.toString());
  assert.equal(pidExists(descendant.pid),true);
  await stopPidTreeByPid(parent.pid);
  await waitForPortsReleased([descendant.port],{timeoutMs:3000,pollIntervalMs:50});
  assert.equal(pidExists(descendant.pid),false);
});
