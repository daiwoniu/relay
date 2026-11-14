import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorEventLoopDelay,performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fixture,markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';

test('Native mixed paginated reads and FULL commits keep the main event loop responsive on a synthetic 10 MB history',async context=>{
  const f=fixture();const seed=new DatabaseSync(f.filename);
  try{
    seed.exec('BEGIN');const insert=seed.prepare("INSERT INTO messages VALUES(?,'session','turn','assistant',?,'final_answer',NULL,NULL,?,NULL,0)");
    const content='synthetic '.repeat(200);for(let index=0;index<5000;index++)insert.run('perf-'+index,content,index+10);seed.exec('COMMIT');
  }finally{seed.close();}
  const client=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const histogram=monitorEventLoopDelay({resolution:10});histogram.enable();
  let ticks=0;const timer=setInterval(()=>{ticks++;},2),start=performance.now();
  try{
    const reads=Array.from({length:40},()=>client.readMessages({principal:markRead().principal,sessionId:'session',limit:50,before:null}));
    const writes=Array.from({length:16},(_,index)=>client.execute(markRead('perf-write-'+index)));
    const results=await Promise.all([...reads,...writes]);
    for(const value of results.slice(40))assert.equal((value as{state:string}).state,'committed');
    assert.ok(ticks>0);
    const metrics={historyMessages:5002,reads:40,writes:16,durationMs:Math.round(performance.now()-start),eventLoopP99Ms:Math.round(histogram.percentile(99)/1e6),eventLoopMaxMs:Math.round(histogram.max/1e6)};
    context.diagnostic(JSON.stringify(metrics));assert.ok(metrics.eventLoopMaxMs<500,'synthetic workload must not stall the main event loop for half a second');
  }finally{clearInterval(timer);histogram.disable();await client.close();f.cleanup();}
});
