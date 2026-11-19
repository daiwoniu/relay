import { createHash,randomUUID } from 'node:crypto';
import { recordTrustedResult } from '../analytics/command-collector.js';
import { FrontendCommandSchema,RELAY_PROTOCOL_VERSION,type FrontendCommand } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import type { StoredRuntimeGraph } from './stored-runtime-graph.js';
import type { StoredSend } from '../services/stored-send.js';
import type { FrontendClient } from './frontend-client-hub.js';
import { StoredSessionRead } from './stored-session-read.js';
import { createMessageOriginForClient } from '../message-origin.js';

/** All browser mutations use freshly authenticated Native principals; no legacy frontend singleton. */
export class StoredFrontendCommands {
  private readonly reads:StoredSessionRead;
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;graph:StoredRuntimeGraph;sender:StoredSend;assertExclusiveWriter:()=>Promise<void>}){
    const {port,storeId,generation,graph}=options;
    this.reads=new StoredSessionRead({port,storeId,generation,publishCurrent:(userId,sessionId)=>graph.hub.broadcastSessionRead(userId,sessionId,principal=>port.readSessionReadReceipt({principal,sessionId}))});
  }
  async handle(client:FrontendClient,raw:unknown){
    const parsed=FrontendCommandSchema.safeParse(raw);if(!parsed.success)throw new StorageContractError('INVALID_ARGUMENT');
    const command=parsed.data,{port,graph}=this.options;
    const principal={kind:'user' as const,userId:client.userId,authSessionHash:client.authTokenHash};
    const sessionId=command.type==='cancel'?command.sessionId??client.activeSubscriptionSessionId:command.sessionId;
    const access=await port.readFrontendAccess({principal,resource:sessionId?{kind:'session',id:sessionId}:null});
    if(!access||!access.allowed||access.user.mustChangePassword||access.expiresAt<=Date.now()||client.ws.readyState!==1
      ||client.userId!==principal.userId||client.authTokenHash!==principal.authSessionHash)throw new StorageContractError('FORBIDDEN');
    client.user=access.user;client.actor={userId:access.user.id,role:access.user.role};client.authExpiresAt=access.expiresAt;
    if(command.type==='subscribe'){
      if(command.client)client.clientEnvironment=command.client;if(command.deviceId)client.deviceId=command.deviceId;
      if(command.resourceScope==='all'&&access.user.role!=='admin')throw new StorageContractError('FORBIDDEN');
      if(command.resourceScope)client.resourceScope=command.resourceScope;
      return graph.sync.subscribe(client,command.sessionId,command.active!==false,command.includeMessages!==false);
    }
    if(command.type==='unsubscribe')return graph.sync.unsubscribe(client,command.sessionId);
    if(command.type==='mark_session_read')return this.reads.handle(client,command);
    if(command.type==='send'){
      if(command.client)client.clientEnvironment=command.client;if(command.clientDiagnostics)client.clientDiagnostics=command.clientDiagnostics;
      const result=await this.options.sender.send(principal,command,createMessageOriginForClient(client));
      if(result.replayed&&client.subscribedSessionIds.has(command.sessionId))await graph.sync.subscribe(client,command.sessionId,client.activeSubscriptionSessionId===command.sessionId,true);
      return result;
    }
    if(command.type==='cancel_followup')return graph.followups.cancel(principal,command.sessionId,command.messageId);
    if(command.type==='resume_followups')return graph.followups.resume(principal,command.sessionId);
    if(command.type==='respond_interaction'){
      if(command.interactionId.startsWith('async-question:')&&command.action==='cancel'){
        await this.options.assertExclusiveWriter();
        const result=await executeStoredCommand(port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,
          requestId:randomUUID(),operationId:'question-close:'+command.operationId,principal,
          command:{name:'asyncQuestion.close',input:{sessionId:command.sessionId,questionId:command.interactionId}}});
        if(result.state==='committed'){
          const item=result.value.item,runtime=graph.runtimes.get(command.sessionId);
          if(runtime)runtime.turnItems=runtime.turnItems.map(old=>old.id===item.id?item:old);
          await Promise.allSettled(graph.hub.clients().filter(recipient=>recipient.userId===principal.userId).map(recipient=>graph.hub.send(recipient,{
            type:'pending_approval_resolved',sessionId:command.sessionId,interactionId:command.interactionId,resolvedAction:'cancel',item})));
          void graph.refresh(command.sessionId).catch(()=>undefined);
        }
        await graph.hub.send(client,{type:'interaction_response_result',operationId:command.operationId,sessionId:command.sessionId,interactionId:command.interactionId,
          outcome:result.state==='committed'?'accepted':'failed',...(result.state!=='committed'?{message:'问题状态已变化，请刷新后核对'}:{})});
        return result;
      }
      const result=await graph.responses.respond(principal,command);
      if(result.state==='submitted'&&command.action!=='cancel')recordTrustedResult(port,client.actor,'interaction',command.action==='accept'?'approve':command.action==='accept_for_session'?'approve_session':command.action==='decline'?'reject':command.formData?'submit_mcp':'submit_answer',`interaction:${command.operationId}`,command.operationId);
      await graph.hub.send(client,{type:'interaction_response_result',operationId:command.operationId,sessionId:command.sessionId,interactionId:command.interactionId,
        outcome:result.state==='submitted'?'accepted':result.state==='access-denied'?'skipped':'failed',...(result.state==='unknown'?{message:'答复结果暂时无法确认，请刷新状态核对'}:{})});return result;
    }
    if(command.type==='cancel'&&sessionId){
      const state=await port.readSessionSync({principal,sessionId,includeMessages:false});if(!state.activeAttemptId)return;
      const key=createHash('sha256').update(JSON.stringify([principal.userId,sessionId,state.activeAttemptId])).digest('hex');
      if(state.queue?.state==='queued'){
        await this.options.assertExclusiveWriter();const result=await executeStoredCommand(port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,
          requestId:randomUUID(),operationId:'frontend-queue-cancel:'+key,principal,command:{name:'queue.cancel',input:{sessionId,expectedAttemptId:state.activeAttemptId,messageId:'queue-cancel:'+key}}});
        if(result.state!=='committed')throw new StorageContractError(result.state==='rejected'?result.code:'STORAGE_UNAVAILABLE');
        await graph.refresh(sessionId);
        for(const recipient of graph.hub.clients())if(recipient.subscribedSessionIds.has(sessionId))await graph.sync.subscribe(recipient,sessionId,recipient.activeSubscriptionSessionId===sessionId,true);
        return;
      }
      const result=await graph.stop.request(principal,{sessionId,expectedAttemptId:state.activeAttemptId},'frontend-stop:'+key);
      if(result.state==='rejected')throw new StorageContractError(result.code);
      if(result.state==='unknown')throw new StorageContractError('STORAGE_UNAVAILABLE');
      return result;
    }
  }
  async failed(client:FrontendClient,command:Partial<FrontendCommand>|undefined,error:unknown){
    const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';
    const sessionId=command?.type==='cancel'?command.sessionId??client.activeSubscriptionSessionId:command&&'sessionId'in command?command.sessionId:null;
    const message=code==='FORBIDDEN'?'当前操作不可用':code==='CONFLICT'?'状态已变化，请刷新后核对':command?.type==='cancel'?'停止结果暂时无法确认，请刷新状态核对':'操作未能完成，请刷新状态核对';
    await this.options.graph.hub.send(client,{type:'error',protocolVersion:RELAY_PROTOCOL_VERSION,code:command?.type==='cancel'?`TURN_CANCEL_${code}`:code,message,
      ...(command?{commandType:command.type}:{}),
      ...(sessionId?{sessionId}:{}),...(command&&'messageId'in command&&command.messageId?{messageId:command.messageId}:{})});
  }
  close(){return this.reads.close();}
}
