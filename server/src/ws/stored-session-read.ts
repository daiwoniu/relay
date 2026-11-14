import { createHash,randomUUID } from 'node:crypto';
import { MarkSessionReadCommandSchema } from '../contracts/index.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { FrontendClient } from './frontend-client-hub.js';

/** Candidate handler; the hub publisher reloads current receipts for each currently authenticated recipient. */
export class StoredSessionRead {
  private closed=false;
  private readonly pending=new Map<string,Promise<boolean>>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;
    publishCurrent:(userId:string,sessionId:string)=>Promise<void>;
  }){this.options=Object.freeze({...options});}
  handle(client:FrontendClient,raw:unknown):Promise<boolean>{
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    const parsed=MarkSessionReadCommandSchema.safeParse(raw);
    if(!parsed.success||client.ws.readyState!==1||client.activeSubscriptionSessionId!==parsed.data.sessionId||!client.authTokenHash||client.authExpiresAt<=Date.now())return Promise.resolve(false);
    const principal={kind:'user' as const,userId:client.userId,authSessionHash:client.authTokenHash},input={sessionId:parsed.data.sessionId,messageId:parsed.data.messageId};
    const current=()=>!this.closed&&client.ws.readyState===1&&client.userId===principal.userId&&client.authTokenHash===principal.authSessionHash
      &&client.authExpiresAt>Date.now()&&client.activeSubscriptionSessionId===input.sessionId;
    const identity=canonicalJson([principal,input]);const prior=this.pending.get(identity);if(prior)return prior;
    if(this.pending.size>=128)return Promise.reject(new StorageContractError('OVERLOADED'));
    const work=Promise.resolve().then(async()=>{
      const access=await this.options.port.readFrontendAccess({principal,resource:{kind:'session',id:input.sessionId}});
      if(!current()||!access?.allowed||access.user.mustChangePassword||access.expiresAt<=Date.now())return false;
      const operationId='session-read:'+createHash('sha256').update(canonicalJson([principal.userId,input])).digest('hex');
      const result=await executeStoredCommand(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,
        requestId:randomUUID(),operationId,principal,command:{name:'session.markRead',input}});
      if(result.state!=='committed'||!result.value.updated)return false;
      // Never broadcast the message ID in an old operation receipt. The durable current receipt may be newer.
      try{await this.options.publishCurrent(principal.userId,input.sessionId);}catch{/* Reconnect snapshot repairs notification failure. */}
      return true;
    }).catch(()=>false);
    this.pending.set(identity,work);void work.finally(()=>{if(this.pending.get(identity)===work)this.pending.delete(identity);}).catch(()=>undefined);return work;
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending.values()]);}
}
