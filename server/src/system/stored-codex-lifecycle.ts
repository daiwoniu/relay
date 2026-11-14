import type { CoreStoragePort } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';

type Signal={channel:'relay-codex-lifecycle-v1';type:'activity_started'|'idle'};
/** Serial Native activity observations plus process-local holds for provider inspection RPCs. */
export class StoredCodexLifecycle{
  private running=false;private closed=false;private holds=0;private revision=0;
  private last:boolean|null=null;private timer:ReturnType<typeof setInterval>|undefined;
  private pending:Promise<void>|undefined;private again=false;private drained:Array<()=>void>=[];
  constructor(private readonly options:{port:CoreStoragePort;send:(message:Signal)=>void;ensureReady:()=>Promise<unknown>;assertExclusiveWriter:()=>Promise<void>;intervalMs?:number}){}
  private signal(active:boolean){if(this.closed||!this.running||this.last===active)return;this.options.send({channel:'relay-codex-lifecycle-v1',type:active?'activity_started':'idle'});this.last=active;}
  private poll():Promise<void>{
    if(!this.running||this.closed)return Promise.resolve();
    if(this.pending){this.again=true;return this.pending;}
    const run=(async()=>{do{
      this.again=false;const observed=this.revision;
      try{
        const current=await this.options.port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}});
        await this.options.assertExclusiveWriter();
        if(observed!==this.revision){this.again=true;continue;}
        this.signal(this.holds>0||current.byEngine.codex>0);
      }catch{/* Unknown activity or owner loss can never publish idle. */}
    }while(this.again&&this.running&&!this.closed);})();
    this.pending=run;void run.finally(()=>{if(this.pending===run)this.pending=undefined;}).catch(()=>undefined);return run;
  }
  async start(){if(this.closed)throw new StorageContractError('NOT_SUBMITTED');if(this.running)return;this.running=true;await this.poll();
    if(this.running&&!this.closed){this.timer=setInterval(()=>{void this.poll();},this.options.intervalMs??500);this.timer.unref?.();}}
  async ensureReady(){
    if(this.closed||!this.running)throw new StorageContractError('NOT_SUBMITTED');
    this.holds++;this.revision++;
    try{await this.options.assertExclusiveWriter();this.signal(true);await this.options.ensureReady();return true;}
    catch(error){this.releaseReady();throw error;}
  }
  releaseReady(){
    if(this.holds===0)return;this.holds--;this.revision++;
    if(this.holds===0){for(const resolve of this.drained.splice(0))resolve();}void this.poll();
  }
  async close(){this.closed=true;this.running=false;if(this.timer)clearInterval(this.timer);this.timer=undefined;
    if(this.holds>0)await new Promise<void>(resolve=>this.drained.push(resolve));await this.pending;}
}
