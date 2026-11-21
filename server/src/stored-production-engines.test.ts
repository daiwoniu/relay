import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoredProductionEngines } from './stored-production-engines.js';

test('production engine construction selects four adapters passively and Codex catalog uses the explicit Native lifecycle',async()=>{
  let reads=0,holds=0;const engines=createStoredProductionEngines({root:'D:/synthetic-never-opened',
    withCodexReady:async work=>{holds++;return work();},codexModelReader:async()=>{reads++;return{engineId:'codex',fetchedAt:1,stale:false,models:[]};}});
  try{
    assert.deepEqual(engines.registry.list().map(adapter=>adapter.id),['codex','codebuddy','opencode','zcode']);
    assert.equal(reads,0);assert.equal(holds,0);
    assert.equal((await engines.registry.get('codex').models!.listModels()).engineId,'codex');
    assert.equal(reads,1);assert.equal(holds,1);
  }finally{engines.close();}
});

test('维护面板运行版本共享握手缓存，进程停止或维护终态后重新采集',async()=>{
  let ready=true,reads=0;
  const engines=createStoredProductionEngines({root:'D:/synthetic-never-opened',withCodexReady:async work=>work(),
    statusOptions:{codexProcessReady:async()=>ready},codexRunningVersionReader:async()=>{reads++;return reads===1?'0.165.0':'0.171.0';}});
  try{
    const codex=engines.maintenanceAdapters.find(adapter=>adapter.id==='codex')!;
    const pair=await Promise.all([codex.getStatus(),codex.getStatus()]);
    assert.deepEqual(pair.map(status=>status.runningVersion),['0.165.0','0.165.0']);
    assert.equal(reads,1);
    engines.onTerminal({engineId:'codex'});
    assert.equal((await codex.getStatus()).runningVersion,'0.171.0');
    assert.equal(reads,2);
    ready=false;assert.equal((await codex.getStatus()).runningVersion,null);
    ready=true;assert.equal((await codex.getStatus()).runningVersion,'0.171.0');assert.equal(reads,3);
  }finally{engines.close();}
});

test('维护终态不能被旧握手结果覆盖，握手失败不伪造已安装版本',async()=>{
  let resolve!:(value:string)=>void,reads=0;
  const engines=createStoredProductionEngines({root:'D:/synthetic-never-opened',withCodexReady:async work=>work(),
    statusOptions:{codexProcessReady:async()=>true},codexRunningVersionReader:()=>{
      reads++;return reads===1?new Promise<string>(r=>{resolve=r;}):Promise.reject(new Error('offline'));
    }});
  try{
    const codex=engines.maintenanceAdapters.find(adapter=>adapter.id==='codex')!;
    const pending=codex.getStatus();
    while(!resolve)await new Promise(r=>setTimeout(r,1));
    engines.onTerminal({engineId:'codex'});resolve('0.165.0');
    assert.equal((await pending).runningVersion,null);
    const unknown=await codex.getStatus();assert.equal(unknown.runningVersion,null);assert.equal(unknown.activeInstanceCount,1);
  }finally{engines.close();}
});
