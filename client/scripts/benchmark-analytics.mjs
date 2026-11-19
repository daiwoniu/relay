import { performance } from 'node:perf_hooks';
import { mkdirSync,writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createTracker } from '../src/analytics/tracker.ts';
let requests=0,maxBatchBytes=0;
const tracker=createTracker({enabled:()=>true,extendedEnabled:()=>true,uuid:randomUUID,
  meta:()=>({device:'desktop',browser:'Chrome',os:'Windows',referrerHost:null}),
  send:async body=>{requests++;maxBatchBytes=Math.max(maxBatchBytes,Buffer.byteLength(body));return{ok:true,status:204};}});
tracker.page('chat','/','synthetic');
const samples=[];
for(let i=0;i<10_000;i++){
  const start=performance.now();tracker.action({feature:'layout',action:'toggle_sidebar',surface:'keyboard'});samples.push(performance.now()-start);
  if(i%10===9)await tracker.flush();
}
samples.sort((a,b)=>a-b);
const report={samples:samples.length,p50Ms:samples[5000],p95Ms:samples[9500],p99Ms:samples[9900],requests,maxBatchBytes,quality:tracker.quality()};
mkdirSync(new URL('../../.relay-dev/',import.meta.url),{recursive:true});
writeFileSync(new URL('../../.relay-dev/client-analytics-benchmark.json',import.meta.url),JSON.stringify(report,null,2));
process.stdout.write(JSON.stringify(report)+'\n');
