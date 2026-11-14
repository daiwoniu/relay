import { parentPort,workerData } from 'node:worker_threads';
import path from 'node:path';
import { NativeNewsDriver,openNativeNewsRepository } from './native-news-driver.js';
import { NewsRepository } from './news-repository-core.js';
import type { NewsStorageDriver } from './news-storage-driver.js';
import type { NewsBatch } from './news-repository-core.js';
const {root,scenario,batch}=workerData as{root:string;scenario:'round-trip'|'lost-shard-result'|'lost-owner'|'strict-open';batch:NewsBatch};
let owned=true,lost=false;
const assertWriter=()=>{if(!owned)throw Error('NEWS_OWNER_LOST');};
const driver=new NativeNewsDriver(root,assertWriter,{initialize:true});
const wrapped:NewsStorageDriver={initializeSchemaOnRead:false,open:filename=>driver.open(filename),persist:(filename,db)=>{
  driver.persist(filename,db);
  if(scenario==='lost-shard-result'&&path.basename(filename)!=='news.db'&&!lost){lost=true;throw Error('NEWS_SIMULATED_RESULT_LOST');}
}};
let repository:NewsRepository|undefined;
try{
  if(scenario==='strict-open'){
    const strict=await openNativeNewsRepository(root,assertWriter);try{parentPort!.postMessage({ok:true,value:{status:strict.repository.getStatus()}});}finally{await strict.close();}
  }else{
  repository=new NewsRepository(root,wrapped,driver.open(path.join(root,'news.db')),null);await repository.initialize();
  if(!repository.getStatus().available)throw Error('NEWS_STORAGE_UNAVAILABLE');
  if(scenario==='lost-owner'){
    owned=false;let refused=false;try{await repository.upsertBatch(batch);}catch(error){refused=error instanceof Error&&error.message==='NEWS_OWNER_LOST';}
    await repository.close();repository=undefined;driver.close();owned=true;
    const reopened=await openNativeNewsRepository(root,assertWriter);
    try{parentPort!.postMessage({ok:true,value:{refused,counts:reopened.repository.getSourceItemCounts()}});}finally{await reopened.close();}
  }else{
    try{await repository.upsertBatch(batch);}catch(error){if(scenario!=='lost-shard-result'||!lost)throw error;}
    await repository.close();repository=undefined;driver.close();
    const reopened=await openNativeNewsRepository(root,assertWriter);
    try{
      const from=Math.min(...batch.items.map(item=>item.publishedAt))-1000,to=Math.max(...batch.items.map(item=>item.publishedAt))+1000;
      const page=await reopened.repository.list({from,to,limit:50});
      parentPort!.postMessage({ok:true,value:{page,status:reopened.repository.getStatus(),counts:reopened.repository.getSourceItemCounts(),source:reopened.repository.getSourceState(batch.sourceId),lost}});
    }finally{await reopened.close();}
  }
  }
}catch(error){parentPort!.postMessage({ok:false,code:error instanceof Error&&/^NEWS_[A-Z_]+$/.test(error.message)?error.message:'NEWS_UNAVAILABLE'});}
finally{await repository?.close();driver.close();parentPort!.close();}
