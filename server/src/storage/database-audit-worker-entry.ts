import { parentPort,workerData } from 'node:worker_threads';
import { auditDatabaseInWorker } from './database-audit.js';
try{parentPort!.postMessage({ok:true,value:auditDatabaseInWorker(workerData.filename)});}
catch(error){const code=error instanceof Error&&/^AUDIT_[A-Z_]+$/.test(error.message)?error.message:'AUDIT_UNAVAILABLE';parentPort!.postMessage({ok:false,code});}
finally{parentPort!.close();}
