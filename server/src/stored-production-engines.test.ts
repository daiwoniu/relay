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
