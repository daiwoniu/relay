import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReady } from './lib/launcher-core.mjs';

test('backend startup budget allows migration beyond 30 seconds while ordinary services keep their deadline',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout']});
  let healthy=false;
  const backend=waitForReady({name:'backend',healthUrl:'synthetic',startupTimeoutMs:600000},{exitCode:null,signalCode:null},async()=>healthy);
  const frontend=waitForReady({name:'frontend',healthUrl:'synthetic'},{exitCode:null,signalCode:null},async()=>false);
  const expired=assert.rejects(frontend,/30 秒/);
  await Promise.resolve();t.mock.timers.tick(31000);healthy=true;
  await backend;await expired;
});

test('long startup budget still detects an exited backend immediately',async()=>{
  await assert.rejects(waitForReady({name:'backend',healthUrl:'synthetic',startupTimeoutMs:600000},{exitCode:1,signalCode:null},async()=>false),/退出码 1/);
});

test('explicit caller timeout overrides the service budget',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout']});
  const waiting=waitForReady({name:'backend',healthUrl:'synthetic',startupTimeoutMs:600000},{exitCode:null,signalCode:null},async()=>false,1000);
  const rejected=assert.rejects(waiting,/1 秒/);
  await Promise.resolve();t.mock.timers.tick(2000);await rejected;
});
