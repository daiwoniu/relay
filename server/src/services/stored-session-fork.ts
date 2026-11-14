import { createHash, randomUUID } from 'node:crypto';
import type { CoreCommandInputs, CoreStoragePort, StorageCommandEnvelope, StoragePrincipal } from '../storage/contracts.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { canonicalJson, StorageContractError } from '../storage/command-boundary.js';
import type { SessionDto, UploadedFileAttachmentDto } from '../contracts/index.js';
import type { ForkUploadCopyInput } from '../uploads/project-uploads.js';

type Principal = Extract<StoragePrincipal,{kind:'user'}>;
type Plan = Awaited<ReturnType<CoreStoragePort['readForkPlan']>>;
type Names = 'session.prepareFork'|'session.claimFork'|'session.acknowledgeFork'|'session.finishFork';
type Outcome = { state: 'unknown' } | { state: 'committed'; session: SessionDto | null };
type Scope = { sessionId: string; externalOperationId: string };
/** External fork dispatch is never retried on ambiguity. Known child IDs are recorded before any file copy. */
export class StoredSessionForkService {
  private closed=false;
  private readonly pending = new Map<string,Promise<Outcome>>();
  private readonly dispatches = new Set<Promise<boolean>>();
  private dispatchSlots = 0;
  private readonly known = new Map<string,{ childId: string; claimToken: string;sessionId:string }>();
  constructor(private readonly options: { port: CoreStoragePort; storeId: string; generation: number;
    /** Implementations must check mayDispatch after any asynchronous setup, immediately before the provider write. */
    fork: (plan: Plan, mayDispatch: () => Promise<boolean>) => Promise<string>;
    copy: (input: ForkUploadCopyInput,context:{principal:Principal;mayCopy:()=>Promise<boolean>}) => Promise<UploadedFileAttachmentDto[]>;
    changed: (sessionId: string, projectId: string) => void | Promise<void>;
    externalTimeoutMs?: number;
  }) {
    this.options = Object.freeze({ ...options });
    if (options.externalTimeoutMs !== undefined && (!Number.isSafeInteger(options.externalTimeoutMs) || options.externalTimeoutMs < 1 || options.externalTimeoutMs > 30_000)) throw new StorageContractError('INVALID_ARGUMENT');
  }
  run(principal: Principal, sessionId: string, messageId: string | null, key: string): Promise<Outcome> {
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    const stable = JSON.parse(canonicalJson({ principal, sessionId, messageId, key }));
    const identity = canonicalJson(stable), existing = this.pending.get(identity); if (existing) return existing;
    if (this.pending.size >= 128) return Promise.reject(new StorageContractError('OVERLOADED'));
    const work = this.perform(stable.principal, stable.sessionId, stable.messageId, stable.key);
    const tracked = work.finally(() => { if (this.pending.get(identity) === tracked) this.pending.delete(identity); });
    this.pending.set(identity,tracked); return tracked;
  }
  private request<K extends Names>(principal: StoragePrincipal, operationId: string, name: K, input: CoreCommandInputs[K]) {
    return { protocolVersion: 1 as const, storeId: this.options.storeId, workerGeneration: this.options.generation,
      requestId: randomUUID(), operationId, principal, command: { name, input } } as StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } };
  }
  private async acknowledge(scope: Scope, value: {childId:string;claimToken:string}): Promise<boolean> {
    this.known.set(scope.externalOperationId,{...value,sessionId:scope.sessionId});
    const command = this.request({ kind:'system',purpose:'recovery' }, `fork:ack:${scope.externalOperationId}`, 'session.acknowledgeFork', { ...scope, ...value });
    const result = await executeStoredCommand(this.options.port,command);
    if (result.state === 'committed') { this.known.delete(scope.externalOperationId); return true; }
    return false;
  }
  private async complete(principal: Principal, value: {forkedSessionId:string;projectId:string}): Promise<Outcome> {
    try { await this.options.changed(value.forkedSessionId,value.projectId); } catch { console.warn('[Fork] 当前资源通知暂不可用'); }
    try { return { state:'committed',session:await this.options.port.readSession({principal,sessionId:value.forkedSessionId}) }; }
    catch { return {state:'committed',session:null}; }
  }
  private async dispatch(principal: Principal, scope: Scope, plan: Plan): Promise<boolean> {
    // Reserve synchronously, before the claim RPC yields to another request.
    if(this.dispatchSlots+this.known.size>=16)throw new StorageContractError('OVERLOADED');
    this.dispatchSlots++;let transferred=false;
    try {
      const o=this.options;
      const claim=await executeStoredCommand(o.port,this.request(principal,'fork:claim:'+randomUUID(),'session.claimFork',scope));
      if(claim.state!=='committed'||!claim.value.claimed||!claim.value.claimToken)return false;
      const claimToken=claim.value.claimToken;
      const mayDispatch=async()=>{if(this.closed)return false;const current=await o.port.readForkPlan({principal,...scope,after:-1});return !this.closed&&current.phase==='dispatched'&&!current.childId&&current.claimToken===claimToken;};
      const dispatch=Promise.resolve().then(async()=>{
        if(!await mayDispatch())return false;
        const childId=await o.fork(plan,mayDispatch);
        if(typeof childId!=='string'||!childId||childId.length>256)return false;
        return this.acknowledge(scope,{childId,claimToken});
      }).catch(()=>false);
      this.dispatches.add(dispatch);transferred=true;
      void dispatch.finally(()=>{this.dispatches.delete(dispatch);this.dispatchSlots--;}).catch(()=>undefined);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{return await Promise.race([dispatch,new Promise<false>((resolve)=>{timer=setTimeout(()=>resolve(false),o.externalTimeoutMs??10_000);timer.unref();})]);}
      finally{if(timer)clearTimeout(timer);}
    }finally{if(!transferred)this.dispatchSlots--;}
  }
  private async perform(principal: Principal, sessionId: string, messageId: string | null, key: string): Promise<Outcome> {
    const o=this.options, userKey=createHash('sha256').update(principal.userId).digest('hex').slice(0,32);
    const prepared=await executeStoredCommand(o.port,this.request(principal,`fork:${userKey}:${key}:prepare`,'session.prepareFork',{sessionId,messageId}));
    if(prepared.state==='rejected')throw new StorageContractError(prepared.code);
    if(prepared.state!=='committed')return {state:'unknown'};
    const scope={sessionId,externalOperationId:prepared.value.externalOperationId}, finishKey=`fork:finish:${scope.externalOperationId}`;
    const prior=await o.port.lookup({storeId:o.storeId,operationId:finishKey,principal});
    if(prior.state==='committed') {
      if(prior.commandName!=='session.finishFork'||prior.value.sessionId!==sessionId||prior.value.forkedSessionId!==prepared.value.forkedSessionId)throw new StorageContractError('CONFLICT');
      return this.complete(principal,prior.value);
    }
    if(prior.state==='expired')throw new StorageContractError('OPERATION_EXPIRED');
    if(prior.state!=='not-found')return {state:'unknown'};
    const remembered=this.known.get(scope.externalOperationId);
    if(remembered&&!await this.acknowledge(scope,remembered))return {state:'unknown'};
    let plan=await o.port.readForkPlan({principal,...scope,after:-1});
    if(!plan.childId) {
      if(!await this.dispatch(principal,scope,plan))return {state:'unknown'};
      plan=await o.port.readForkPlan({principal,...scope,after:-1});
    }
    if(!plan.childId)return {state:'unknown'};
    const uploads: CoreCommandInputs['session.finishFork']['uploads']=[];
    let after=-1;
    do {
      const current=after===-1?plan:await o.port.readForkPlan({principal,...scope,after});
      for(const copy of current.copies) {
        if(uploads.length>=2000)throw new StorageContractError('PAYLOAD_TOO_LARGE');
        // File intent comes only from an authorized DB plan; the browser cannot supply paths or identities.
        let attachments:UploadedFileAttachmentDto[];
        const mayCopy=async()=>!this.closed&&canonicalJson(await o.port.readForkPlan({principal,...scope,after}))===canonicalJson(current)&&!this.closed;
        try { if(!await mayCopy())return{state:'unknown'};attachments=await o.copy({operationId:scope.externalOperationId,projectPath:current.projectRoot,sourceMessageId:copy.sourceMessageId,targetMessageId:copy.targetMessageId,
          sourceAttachmentIds:copy.attachmentIds,sourceIdentity:{projectId:current.sourceProjectId,userId:current.sourceUserId},
          targetIdentity:{projectId:current.targetProjectId,userId:principal.userId}},{principal,mayCopy}); }
        catch{return {state:'unknown'};}
        uploads.push({sourceMessageId:copy.sourceMessageId,attachments});canonicalJson(uploads,6*1024*1024);
      }
      if(current.next===null)break;
      if(current.next<=after)throw new StorageContractError('CONFLICT');after=current.next;
    } while(true);
    const result=await executeStoredCommand(o.port,this.request(principal,finishKey,'session.finishFork',{...scope,uploads}));
    if(result.state==='rejected')throw new StorageContractError(result.code);
    return result.state==='committed'?this.complete(principal,result.value):{state:'unknown'};
  }
  async close(){
    this.closed=true;await Promise.allSettled([...this.pending.values()]);await Promise.allSettled([...this.dispatches]);
    for(const [externalOperationId,value]of this.known)if(!await this.acknowledge({sessionId:value.sessionId,externalOperationId},value))throw new StorageContractError('STORAGE_UNAVAILABLE');
  }
}
