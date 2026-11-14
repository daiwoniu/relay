import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { openNewsRepository } from './news-repository.js';
import type { NewsItemInput } from '../types.js';
const first=Date.parse('2026-10-31T10:00:00Z'),second=Date.parse('2026-11-01T10:00:00Z');
const item=(id:string,at:number):NewsItemInput=>({id,eventId:id,sourceId:'source-a',url:`https://example.org/${id}`,title:`Story ${id}`,description:null,publishedAt:at,firstFetchedAt:at+1000,categoryId:'research',topicIds:['agent'],entityIds:[],eventTypeId:'release',language:'en'});
const batch={sourceId:'source-a',fetchedAt:second+1000,nextFetchAt:second+60000,items:[item('first',first),item('second',second)]};
async function run(root:string,scenario:string){
  const worker=new Worker(new URL('./native-news-test-bootstrap.mjs',import.meta.url),{workerData:{root,scenario,batch}});let result:any,error:Error|undefined;
  await new Promise<void>(resolve=>{worker.on('message',value=>{result=value;});worker.on('error',()=>{error=Error('worker failed');});worker.on('exit',code=>{if(code!==0&&!error)error=Error('worker failed');resolve();});});
  if(error)throw error;if(!result?.ok)throw Error(result?.code??'no result');return result.value;
}
test('Native news Worker reopens incremental month databases and recovers a committed shard with a lost result exactly once',async()=>{
  for(const scenario of ['round-trip','lost-shard-result']){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-native-news-'));
    try{
      const result=await run(root,scenario);assert.equal(result.status.available,true);assert.equal(result.page.version,1);
      assert.deepEqual(result.page.items.map((value:any)=>value.id),['second','first']);assert.deepEqual(result.counts,{'source-a':2});
      assert.equal(result.source.lastSuccessAt,batch.fetchedAt);assert.equal(result.lost,scenario==='lost-shard-result');
      assert.deepEqual((await fs.readdir(root)).sort(),['news-2026-10.db','news-2026-11.db','news.db']);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  }
});
test('Native news opens existing legacy databases and rejects a revoked writer without adding rows',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-native-news-'));
  try{
    const legacy=await openNewsRepository(root);await legacy.upsertBatch({...batch,items:[batch.items[0]]});await legacy.close();
    const result=await run(root,'round-trip');assert.deepEqual(result.counts,{'source-a':2});assert.equal(result.page.version,2);
    const refused=await run(root,'lost-owner');assert.equal(refused.refused,true);assert.deepEqual(refused.counts,{'source-a':2});
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('missing metadata beside historical shards and corrupt metadata fail instead of initializing an empty news collection',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-native-news-'));
  try{
    await fs.writeFile(path.join(root,'news-2026-10.db'),'historical shard');await assert.rejects(run(root,'round-trip'),/NEWS_METADATA_MISSING/);
    await assert.rejects(fs.stat(path.join(root,'news.db')),{code:'ENOENT'});
    await fs.writeFile(path.join(root,'news.db'),'corrupt');await assert.rejects(run(root,'round-trip'));
    assert.equal(await fs.readFile(path.join(root,'news.db'),'utf8'),'corrupt');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('strict news startup refuses missing migrations, unknown month versions and schema drift without repairing files',async()=>{
  for(const [name,sql]of [
    ['news.db','DROP TABLE _relay_news_migrations'],
    ['news-2026-10.db','UPDATE _relay_news_migrations SET version=99'],
    ['news.db','ALTER TABLE news_meta ADD COLUMN unexpected TEXT'],
  ]){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-native-news-version-'));
    try{
      await run(root,'round-trip');const filename=path.join(root,name),db=new DatabaseSync(filename);db.exec(sql);db.close();const before=await fs.readFile(filename);
      await assert.rejects(run(root,'strict-open'),/NEWS_MIGRATION_REQUIRED|NEWS_UNSUPPORTED_VERSION/);assert.deepEqual(await fs.readFile(filename),before);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  }
});
