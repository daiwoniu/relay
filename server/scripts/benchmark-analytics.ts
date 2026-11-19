import { DatabaseSync } from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import { statSync,mkdirSync,writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fixture,markRead } from '../src/storage/storage-fixture.test-support.js';
import { HOSTING_SCHEMA_SQL } from '../src/page-hosting/contract.js';
import { AnalyticsReader } from '../src/analytics/reader.js';
import { StorageWorkerClient } from '../src/storage/worker-client.js';
import {nativeQueries} from '../src/storage/native-queries.js';
import {readAnalytics} from '../src/storage/native-analytics.js';

// Synthetic disposable DB only. No Relay config, installed service or live user data is read.
const f=fixture();
let reader:AnalyticsReader|undefined,port:StorageWorkerClient|undefined;
const reports:unknown[]=[];
const elapsed=async(work:()=>Promise<unknown>)=>{const start=performance.now();await work();return Math.round((performance.now()-start)*100)/100;};
try{
  f.mutate(HOSTING_SCHEMA_SQL);
  for(const total of [100_000,1_000_000]){
    const db=new DatabaseSync(f.filename),before=Number(db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get()!.n),at=Date.now()-1000;
    const insertMs=await elapsed(async()=>{
      db.exec('BEGIN');
      db.prepare(`WITH RECURSIVE n(i) AS (VALUES(?) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO analytics_events SELECT printf('%08x-0000-4000-8000-000000000000',i),?,
        CASE WHEN i%10<6 THEN 'page_view' WHEN i%10<8 THEN 'feature_view' WHEN i%10=8 THEN 'feature_action' ELSE 'operation_result' END,
        'chat',NULL,printf('%08x-0000-4000-8000-000000000000',i%1000),'owner','member',NULL,'0',NULL,'desktop','Chrome','Windows',
        CASE WHEN i%10<6 THEN '{}' WHEN i%10<8 THEN '{"feature":"composer","action":"open","surface":"composer"}'
          WHEN i%10=8 THEN '{"feature":"composer","action":"submit","surface":"composer","operationId":"00000000-0000-4000-8000-000000000000"}'
          ELSE '{"feature":"composer","action":"submit","surface":"unknown","operationId":"00000000-0000-4000-8000-000000000000","result":"success"}' END FROM n`).run(before+1,total,at);
      db.exec('COMMIT');
    });db.close();
    reader=new AnalyticsReader(f.filename);
    const query={range:'all' as const,excludeAdmin:false};
    const summaryMs=await elapsed(()=>reader!.read('summary',query));
    const featuresMs=await elapsed(()=>reader!.read('features',query));
    const detailMs=await elapsed(()=>reader!.read('actions',query));
    const filteredDetailMs=await elapsed(()=>reader!.read('actions',{...query,feature:'composer',action:'submit',metric:'action',includeSystem:false}));
    const emptyErrorFilterMs=await elapsed(()=>reader!.read('actions',{...query,result:'error',includeSystem:false}));
    const cacheMs=await elapsed(()=>reader!.read('features',query));
    port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:total===100_000});
    const writes=async(prefix:string)=>{const values:number[]=[];for(let i=0;i<30;i++)values.push(await elapsed(()=>port!.execute(markRead(`${prefix}-${i}`))));return values.sort((a,b)=>a-b);};
    const baseline=await writes(`baseline-${total}`);
    const concurrent=await Promise.all([reader.read('summary',{...query,excludeAdmin:true}),writes(`concurrent-${total}`)]);
    const loaded=concurrent[1];
    const analyticsWrites:number[]=[];
    for(let sample=0;sample<30;sample++){
      const records=Array.from({length:20},()=>({event:{id:randomUUID(),name:'page_view' as const,page:'chat' as const,pageViewId:null,referrerHost:null,device:'unknown' as const,browser:'Other' as const,os:'Other' as const,properties:{}},receivedAt:Date.now(),visitorId:null,userId:null,role:'guest' as const,ip:null,version:'0'}));
      analyticsWrites.push(await elapsed(()=>port!.appendAnalytics({records})));
    }
    analyticsWrites.sort((a,b)=>a-b);
    const profile:Array<{sql:string;ms:number}>=[];
    if(total===1_000_000&&process.argv.includes('--profile')){
      const profiling=new DatabaseSync(f.filename,{readOnly:true}),raw=nativeQueries(profiling);
      const measure=<T>(sql:string,work:()=>T)=>{const start=performance.now();try{return work();}finally{profile.push({sql:sql.slice(0,110),ms:Math.round((performance.now()-start)*100)/100});}};
      readAnalytics({...raw,get:(sql,params)=>measure(sql,()=>raw.get(sql,params)),all:(sql,params)=>measure(sql,()=>raw.all(sql,params))},query,'summary');profiling.close();
    }
    reports.push({rows:total,databaseMB:Math.round(statSync(f.filename).size/1024/1024),insertMs,summaryMs,featuresMs,detailMs,filteredDetailMs,emptyErrorFilterMs,cacheMs,analyticsBatchWrites:{samples:30,batchSize:20,p50:analyticsWrites[15],p95:analyticsWrites[28]},...(profile.length?{profile}:{}),
      businessWrites:{samples:30,baselineP50:baseline[15],baselineP95:baseline[28],concurrentP50:loaded[15],concurrentP95:loaded[28]}});
    mkdirSync(new URL('../../.relay-dev/',import.meta.url),{recursive:true});
    writeFileSync(new URL('../../.relay-dev/analytics-benchmark.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),reports},null,2));
    await reader.close();reader=undefined;await port.close();port=undefined;
    process.stdout.write(JSON.stringify(reports[reports.length-1])+'\n');
  }
}finally{await reader?.close();await port?.close();f.cleanup();}
