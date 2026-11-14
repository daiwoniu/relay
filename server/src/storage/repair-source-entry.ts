import { parentPort,workerData } from 'node:worker_threads';
import { z } from 'zod';
import { canonicalJson, RepairCandidateSchema } from './command-boundary.js';
import { loadRepairSources } from './repair-source.js';
try {
  canonicalJson(workerData,1024*1024);
  const job=z.object({requestId:z.string().uuid(),root:z.string().min(1).max(32768),candidates:z.array(RepairCandidateSchema).max(20)}).strict().parse(workerData);
  const entries=await loadRepairSources(job.root,job.candidates); canonicalJson(entries,6*1024*1024);
  parentPort!.postMessage({requestId:job.requestId,entries});
} catch { parentPort!.postMessage({requestId:workerData?.requestId,error:'REPAIR_SOURCE_UNAVAILABLE'}); }
finally { parentPort!.close(); }
