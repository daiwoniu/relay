import { Worker } from 'node:worker_threads';
import type { DatabaseAudit } from './database-audit.js';

/** At most one physical read-only audit. A timed-out audit is terminated and joined before admission is released. */
export class DatabaseAuditor{
  private closed=false;
  private pending:Promise<DatabaseAudit>|undefined;
  constructor(private readonly timeoutMs=10*60*1000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60*60*1000)throw Error('AUDIT_INVALID_TIMEOUT');}
  audit(filename:string):Promise<DatabaseAudit>{
    if(this.closed)return Promise.reject(Error('AUDIT_CLOSED'));
    if(this.pending)return Promise.reject(Error('AUDIT_BUSY'));
    const run=this.run(filename);this.pending=run;
    void run.finally(()=>{if(this.pending===run)this.pending=undefined;}).catch(()=>undefined);return run;
  }
  private async run(filename:string){
    const worker=new Worker(new URL('./database-audit-worker-bootstrap.mjs',import.meta.url),{workerData:{filename}});
    let result:{ok:true;value:DatabaseAudit}|{ok:false;code:string}|undefined,failure:Error|undefined;
    const exited=new Promise<void>(resolve=>{
      worker.on('message',value=>{result=value;});worker.on('error',()=>{failure=Error('AUDIT_WORKER_FAILED');});
      worker.on('exit',code=>{if(code!==0&&!failure)failure=Error('AUDIT_WORKER_FAILED');resolve();});
    });
    const timer=setTimeout(()=>{failure=Error('AUDIT_TIMEOUT');void worker.terminate();},this.timeoutMs);
    try{await exited;if(failure)throw failure;if(!result)throw Error('AUDIT_NO_RESULT');if(!result.ok)throw Error(result.code);return result.value;}
    finally{clearTimeout(timer);}
  }
  async close(){this.closed=true;await this.pending?.catch(()=>undefined);}
}
