import { WebSocket } from 'ws';
import { z } from 'zod';
import { FrontendEventSchema, RELAY_PROTOCOL_VERSION, type FrontendEvent,type NotificationPreferencesDto,type AccountThemeSettingsDto } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { canonicalJson } from '../storage/command-boundary.js';
import type { StoragePrincipal } from '../storage/contracts.js';
import type { FrontendClient } from './frontend-client-hub.js';
import { presentMessage,type AttachmentAvailability } from '../messages/presenter.js';

type Resource = { kind: 'project' | 'session'; id: string };
type ScopedEvent = Exclude<Extract<FrontendEvent, { sessionId: string }>, { type: 'interaction_response_result' }>;
type TrustEvent = Extract<FrontendEvent, { type: 'approval_trust_updated' }>;
interface Connection {
  client: FrontendClient; userId: string; tokenHash: string; alive: boolean;
  tail: Promise<unknown>; pending: number; bytes: number;
  subscriptions: Map<string, { sequence:number; durable:number; cut:number }>;
  initialIntent?: object;
}
export interface SyncContext {
  principal: Extract<StoragePrincipal,{kind:'user'}>; scope:'mine'|'all'; activeSessionId:string|null;
}
export interface PreparedFrontendSync {
  role:'admin'|'member';events:FrontendEvent[];isCurrent:()=>boolean;recheck:()=>Promise<boolean>;
}
export type FrontendSyncLoader=(context:SyncContext)=>Promise<()=>PreparedFrontendSync>;
const STREAM_SNAPSHOT_EVENTS=new Set(['delta','item_start','item_complete','request_forwarded']);
const MAX_SUBSCRIPTIONS = 16;
const MAX_PENDING = 128;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT = 2_147_000_000;
const uuid = z.string().uuid();

/** Isolated native candidate. No global legacy hub, database, runtime or revocation listeners. */
export class StoredFrontendHub {
  private readonly connections = new Map<FrontendClient['ws'], Connection>();
  constructor(private readonly port: Pick<CoreStoragePort, 'readFrontendAccess' | 'readProject'>,
    private readonly loadAttachmentAvailability?:(paths:readonly string[])=>Promise<AttachmentAvailability>) {}
  clients():FrontendClient[]{return [...this.connections.values()].filter(state=>this.current(state)).map(state=>state.client);}
  async send(client:FrontendClient,event:FrontendEvent){
    const state=this.connections.get(client.ws);if(!state||state.client!==client)return false;
    const captured=FrontendEventSchema.parse(structuredClone(event)),payload=canonicalJson(captured,1024*1024);
    const resource='sessionId'in captured&&typeof captured.sessionId==='string'?{kind:'session' as const,id:captured.sessionId}:null;
    return this.enqueue(state,Buffer.byteLength(payload),async()=>await this.authorized(state,resource)&&this.current(state)?this.write(state,payload):false);
  }
  async broadcastLoaded(load:(principal:SyncContext['principal'])=>Promise<FrontendEvent|null>){
    const results=await Promise.allSettled([...this.connections.values()].map(state=>this.enqueue(state,512*1024,async()=>{
      if(!await this.authorized(state,null))return false;const principal=this.syncContext(state).principal;
      const event=await load(principal);if(!event||!this.current(state))return false;
      const latest=await load(principal);if(!this.current(state)||canonicalJson(latest)!==canonicalJson(event))return false;
      return this.write(state,canonicalJson(FrontendEventSchema.parse(event)));
    })));
    if(results.some(result=>result.status==='rejected'))throw new Error('FRONTEND_PUBLICATION_UNAVAILABLE');
  }
  async broadcastResource(resource:Resource,read:CoreStoragePort['readResourceEvent'],present?:(event:NonNullable<Awaited<ReturnType<CoreStoragePort['readResourceEvent']>>>)=>FrontendEvent){
    const results=await Promise.allSettled([...this.connections.values()].map(state=>{
      const subscription=resource.kind==='session'?state.subscriptions.get(resource.id):undefined;if(subscription)subscription.durable++;
      return this.enqueue(state,512*1024,async()=>{
      if(!await this.authorized(state,null))return false;const context=this.syncContext(state),input={principal:context.principal,resource,scope:context.scope};
      const event=await read(input);if(!event||!this.current(state))return false;
      const latest=await read(input);if(!this.current(state)||canonicalJson(latest)!==canonicalJson(event))return false;
      if(event.type==='session_deleted')this.unsubscribe(state.client,event.sessionId);
      return this.write(state,canonicalJson(FrontendEventSchema.parse(present?present(event):event)));
    });}));
    if(results.some(result=>result.status==='rejected'))throw new Error('FRONTEND_RESOURCE_PUBLICATION_UNAVAILABLE');
  }
  private current(state: Connection) {
    const c = state.client;
    return state.alive && this.connections.get(c.ws) === state && c.userId === state.userId
      && c.authTokenHash === state.tokenHash && c.ws.readyState === WebSocket.OPEN;
  }
  private clearSubscriptions(state: Connection) {
    state.initialIntent=undefined;
    state.subscriptions.clear(); state.client.subscribedSessionIds.clear(); state.client.activeSubscriptionSessionId = null;
  }
  remove(client: FrontendClient): void {
    const state = this.connections.get(client.ws);
    if (!state || state.client !== client) return;
    state.alive = false; this.connections.delete(client.ws); this.clearSubscriptions(state);
    if (client.authExpiryTimer) clearTimeout(client.authExpiryTimer);
    client.authExpiryTimer = null;
  }
  private revoke(state: Connection) {
    if (!this.current(state)) return;
    const client = state.client; this.remove(client); client.authExpiresAt = 0;
    try { client.ws.close(1008, '登录已失效'); } catch { /* Already detached; no engine lifecycle action. */ }
  }
  private scheduleExpiry(state: Connection) {
    const client = state.client;
    if (client.authExpiryTimer) clearTimeout(client.authExpiryTimer);
    const remaining = client.authExpiresAt - Date.now();
    if (remaining <= 0) { this.revoke(state); return; }
    client.authExpiryTimer = setTimeout(() => {
      client.authExpiryTimer = null;
      if (!this.current(state)) return;
      if (client.authExpiresAt <= Date.now()) this.revoke(state); else this.scheduleExpiry(state);
    }, Math.min(remaining, MAX_TIMEOUT));
    client.authExpiryTimer.unref();
  }
  private enqueue<T>(state: Connection, bytes: number, work: () => Promise<T>): Promise<T | false> {
    if (!this.current(state)) return Promise.resolve(false);
    if (state.pending >= MAX_PENDING || state.bytes + bytes > MAX_BYTES) {this.disconnectSlowClient(state);return Promise.reject(new Error('FRONTEND_QUEUE_OVERLOADED'));}
    state.pending++; state.bytes += bytes;
    const result = state.tail.catch(() => undefined).then<T | false>(() => this.current(state) ? work() : false);
    // Own failures internally as well: event listeners may discard the returned promise.
    state.tail = result.catch(() => undefined);
    void result.finally(() => { state.pending--; state.bytes -= bytes; }).catch(() => undefined);
    return result;
  }
  private async authorized(state: Connection, resource: Resource | null): Promise<boolean> {
    if (!this.current(state)) return false;
    if (state.client.authExpiresAt <= Date.now()) { this.revoke(state); return false; }
    const access = await this.port.readFrontendAccess({ principal: { kind: 'user', userId: state.userId, authSessionHash: state.tokenHash }, resource });
    if (!this.current(state)) return false;
    if (!access || access.user.id !== state.userId || access.user.mustChangePassword || access.expiresAt <= Date.now()) {
      this.revoke(state); return false;
    }
    state.client.user = access.user; state.client.actor = { userId: access.user.id, role: access.user.role };
    const changedExpiry = state.client.authExpiresAt !== access.expiresAt;
    state.client.authExpiresAt = access.expiresAt;
    if (changedExpiry || !state.client.authExpiryTimer) this.scheduleExpiry(state);
    return access.allowed;
  }
  private write(state: Connection, payload: string): Promise<boolean> {
    if (!this.current(state)) return Promise.resolve(false);
    if (state.client.ws.bufferedAmount + Buffer.byteLength(payload) > MAX_BYTES) {this.disconnectSlowClient(state);return Promise.reject(new Error('FRONTEND_SEND_OVERLOADED'));}
    return new Promise((resolve, reject) => {
      const fail=(code:string)=>{this.disconnectSlowClient(state);reject(new Error(code));};
      const timer = setTimeout(() => fail('FRONTEND_SEND_TIMEOUT'), 10_000); timer.unref();
      try { state.client.ws.send(payload, (error) => { clearTimeout(timer); error ? fail('FRONTEND_SEND_FAILED') : resolve(true); }); }
      catch { clearTimeout(timer); fail('FRONTEND_SEND_FAILED'); }
    });
  }
  private disconnectSlowClient(state:Connection){
    if(!this.current(state))return;this.remove(state.client);
    try{state.client.ws.close(1013,'Synchronization required');}catch{/* Client is already detached. */}
  }
  async add(client: FrontendClient): Promise<boolean> {
    const previous = this.connections.get(client.ws); if (previous) this.remove(previous.client);
    const state: Connection = { client, userId: client.userId, tokenHash: client.authTokenHash, alive: true,
      tail: Promise.resolve(), pending: 0, bytes: 0, subscriptions: new Map() };
    this.clearSubscriptions(state); this.connections.set(client.ws, state);
    try { return await this.enqueue(state, 0, () => this.authorized(state, null)); }
    catch (error) { if (this.connections.get(client.ws) === state) this.remove(client); throw error; }
  }
  subscribe(client: FrontendClient, sessionId: string, active = true): Promise<boolean> {
    if (!uuid.safeParse(sessionId).success) return Promise.reject(new Error('FRONTEND_SESSION_ID_INVALID'));
    const state = this.connections.get(client.ws);
    if (!state || state.client !== client) return Promise.resolve(false);
    const intent = {sequence:0,durable:0,cut:-1}; state.subscriptions.set(sessionId, intent);
    // Reserve before awaiting; unsubscribe/re-subscribe invalidates older in-flight requests.
    if (state.subscriptions.size > MAX_SUBSCRIPTIONS) { state.subscriptions.delete(sessionId); return Promise.reject(new Error('FRONTEND_SUBSCRIPTION_LIMIT')); }
    const result = this.enqueue(state, 0, async () => {
      const allowed = await this.authorized(state, { kind: 'session', id: sessionId });
      if (!this.current(state) || state.subscriptions.get(sessionId) !== intent) return false;
      if (!allowed) { this.unsubscribe(client, sessionId); return false; }
      client.subscribedSessionIds.add(sessionId);
      if (active) client.activeSubscriptionSessionId = sessionId;
      else if (client.activeSubscriptionSessionId === sessionId) client.activeSubscriptionSessionId = null;
      return true;
    });
    void result.catch(() => { if (state.subscriptions.get(sessionId) === intent) this.unsubscribe(client, sessionId); });
    return result;
  }
  private syncContext(state:Connection):SyncContext {
    return {principal:{kind:'user',userId:state.userId,authSessionHash:state.tokenHash},scope:state.client.resourceScope??'mine',activeSessionId:state.client.activeSubscriptionSessionId};
  }
  private syncPayload(batch:PreparedFrontendSync,sessionId?:string):string[] {
    if(!Array.isArray(batch.events)||batch.events.length>10)throw new Error('FRONTEND_SNAPSHOT_INVALID');
    const allowed=sessionId?new Set(['session_updated','sync_state','runtime_sync_state','session_followup_snapshot','model_info','token_usage','pending_approvals_snapshot'])
      :new Set(['protocol_info','session_reads','pending_approvals_snapshot']);
    const events=batch.events.map((event)=>{
      const parsed=FrontendEventSchema.parse(event);
      if(!allowed.has(parsed.type)||'sessionId' in parsed&&parsed.sessionId!==sessionId||parsed.type==='session_updated'&&parsed.snapshot!==true)throw new Error('FRONTEND_SNAPSHOT_INVALID');
      return parsed;
    });
    canonicalJson(events,7*1024*1024);return events.map((event)=>JSON.stringify(event));
  }
  initialize(client:FrontendClient,load:FrontendSyncLoader):Promise<boolean> {
    const state=this.connections.get(client.ws);if(!state||state.client!==client)return Promise.resolve(false);
    const intent={};state.initialIntent=intent;
    return this.enqueue(state,0,async()=>{
      initialRetry:for(let tries=0;tries<3;tries++){
        if(!await this.authorized(state,null))return false;
        if(!this.current(state)||state.initialIntent!==intent)return false;
        const context=this.syncContext(state),build=await load(context);
        if(!this.current(state)||state.initialIntent!==intent)return false;
        let batch:PreparedFrontendSync;
        try{batch=build();}catch(error){if(error instanceof Error&&error.message==='FRONTEND_SNAPSHOT_STALE')continue;throw error;}
        const payloads=this.syncPayload(batch);
        if(!await this.authorized(state,null))return false;
        if(!this.current(state)||state.initialIntent!==intent)return false;
        if(batch.role!==client.actor.role||!batch.isCurrent()||context.scope!==(client.resourceScope??'mine')||context.activeSessionId!==client.activeSubscriptionSessionId)continue;
        for(const payload of payloads){
          if(!await this.authorized(state,null))return false;
          if(!this.current(state)||state.initialIntent!==intent)return false;
          if(!await batch.recheck())continue initialRetry;
          if(!this.current(state)||state.initialIntent!==intent)return false;
          if(batch.role!==client.actor.role||!batch.isCurrent()||context.scope!==(client.resourceScope??'mine')||context.activeSessionId!==client.activeSubscriptionSessionId)continue initialRetry;
          await this.write(state,payload);
        }
        return true;
      }
      throw new Error('FRONTEND_SNAPSHOT_STALE');
    });
  }
  synchronize(client:FrontendClient,sessionId:string,options:{active:boolean;includeMessages:boolean},load:FrontendSyncLoader):Promise<boolean> {
    if(!uuid.safeParse(sessionId).success||typeof options.active!=='boolean'||typeof options.includeMessages!=='boolean')return Promise.reject(new Error('FRONTEND_SESSION_ID_INVALID'));
    const state=this.connections.get(client.ws);if(!state||state.client!==client)return Promise.resolve(false);
    // Runtime/followup refreshes contain no saved messages. Keep the existing
    // subscription so queued durable publications are not invalidated and lost.
    // A full history subscription still replaces it and supersedes the old stream.
    const previous=!options.includeMessages&&client.subscribedSessionIds.has(sessionId)?state.subscriptions.get(sessionId):undefined;
    const intent=previous??{sequence:0,durable:0,cut:-1};state.subscriptions.set(sessionId,intent);
    if(state.subscriptions.size>MAX_SUBSCRIPTIONS){state.subscriptions.delete(sessionId);return Promise.reject(new Error('FRONTEND_SUBSCRIPTION_LIMIT'));}
    const current=()=>this.current(state)&&state.subscriptions.get(sessionId)===intent;
    return this.enqueue(state,0,async()=>{
      try{
        snapshotRetry:for(let tries=0;tries<3;tries++){
          if(!await this.authorized(state,{kind:'session',id:sessionId})){if(current())await this.recheckDeniedSession(state,sessionId);return false;}
          if(!current())return false;
          client.subscribedSessionIds.add(sessionId);
          if(options.active)client.activeSubscriptionSessionId=sessionId;else if(client.activeSubscriptionSessionId===sessionId)client.activeSubscriptionSessionId=null;
          const version=intent.durable,context=this.syncContext(state),build=await load(context);
          if(!current())return false;
          if(version!==intent.durable)continue;
          let batch:PreparedFrontendSync;
          try{batch=build();}catch(error){if(error instanceof Error&&error.message==='FRONTEND_SNAPSHOT_STALE')continue;throw error;}
          // Capture the stream cut in the same synchronous turn as the runtime snapshot.
          const cut=intent.sequence,payloads=this.syncPayload(batch,sessionId);
          if(!await this.authorized(state,{kind:'session',id:sessionId})){if(current())await this.recheckDeniedSession(state,sessionId);return false;}
          if(!current())return false;
          if(version!==intent.durable||batch.role!==client.actor.role||!batch.isCurrent()||context.scope!==(client.resourceScope??'mine'))continue;
          intent.cut=cut;
          for(const payload of payloads){
            if(!await this.authorized(state,{kind:'session',id:sessionId})){if(current())await this.recheckDeniedSession(state,sessionId);return false;}
            if(!current())return false;
            if(!await batch.recheck())continue snapshotRetry;
            if(!current())return false;
            if(version!==intent.durable||batch.role!==client.actor.role||!batch.isCurrent()||context.scope!==(client.resourceScope??'mine'))continue snapshotRetry;
            await this.write(state,payload);
          }
          return true;
        }
        throw new Error('FRONTEND_SNAPSHOT_STALE');
      }catch(error){if(current())this.unsubscribe(client,sessionId);throw error;}
    });
  }
  unsubscribe(client: FrontendClient, sessionId: string): void {
    const state = this.connections.get(client.ws);
    if (!state || state.client !== client) return;
    state.subscriptions.delete(sessionId); client.subscribedSessionIds.delete(sessionId);
    if (client.activeSubscriptionSessionId === sessionId) client.activeSubscriptionSessionId = null;
  }
  async recheckUserAccess(userId: string): Promise<void> {
    const checks = [...this.connections.values()].filter((s) => s.userId === userId).map((state) => this.enqueue(state, 0, async () => {
      if (!await this.authorized(state, null)) return false;
      for (const id of [...state.client.subscribedSessionIds]) {
        if (!this.current(state)) break;
        const intent = state.subscriptions.get(id);
        const allowed = await this.authorized(state, { kind: 'session', id });
        if (state.subscriptions.get(id) !== intent) continue;
        if (!allowed && this.current(state)) await this.recheckDeniedSession(state, id);
      }
      return true;
    }));
    const results = await Promise.allSettled(checks);
    if (results.some((r) => r.status === 'rejected')) throw new Error('FRONTEND_ACCESS_RECHECK_UNAVAILABLE');
  }
  private async recheckDeniedSession(state: Connection, id: string) {
    this.unsubscribe(state.client, id);
    await this.write(state, JSON.stringify({ type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION,
      sessionId: id, message: '会话不存在', code: 'SESSION_NOT_FOUND' }));
  }
  async recheckProjectAccess(projectId: string, userId: string): Promise<void> {
    if (!uuid.safeParse(projectId).success) throw new Error('FRONTEND_PROJECT_ID_INVALID');
    // A grant/role/visibility change can affect any subscription of this user. Re-read rather than replaying its old receipt.
    await this.recheckUserAccess(userId);
    const results = await Promise.allSettled([...this.connections.values()].filter((s) => s.userId === userId).map((state) =>
      this.enqueue(state, 0, async () => {
        if (!await this.authorized(state, null)) return false;
        const project = await this.port.readProject({ principal: { kind: 'user', userId: state.userId, authSessionHash: state.tokenHash }, projectId });
        if (!this.current(state)) return false;
        return this.write(state, JSON.stringify(project ? { type: 'project_updated', project } : { type: 'project_deleted', projectId }));
      })));
    if (results.some((r) => r.status === 'rejected')) throw new Error('FRONTEND_ACCESS_RECHECK_UNAVAILABLE');
  }
  async broadcastSession(event: ScopedEvent, options?:{isCurrent:()=>boolean}): Promise<{ sent: number; failed: number }> {
    const isCurrent=options?.isCurrent??(()=>true);
    if(!isCurrent())return{sent:0,failed:0};
    const validated = FrontendEventSchema.parse(event);
    if (!('sessionId' in validated) || !validated.sessionId || validated.type === 'interaction_response_result') throw new Error('FRONTEND_SESSION_EVENT_INVALID');
    const parsed = validated as ScopedEvent;
    const payload = JSON.stringify(parsed); const bytes = Buffer.byteLength(payload);
    const jobs = [...this.connections.values()].filter((s) => s.client.subscribedSessionIds.has(parsed.sessionId)).map((state) => {
      const intent = state.subscriptions.get(parsed.sessionId);
      const sequence=intent?++intent.sequence:0;
      const covered=STREAM_SNAPSHOT_EVENTS.has(parsed.type);
      if(intent&&!covered)intent.durable++;
      return this.enqueue(state, bytes, async () => {
        if(!isCurrent())return false;
        if(covered&&intent&&sequence<=intent.cut)return false;
        const allowed = await this.authorized(state, { kind: 'session', id: parsed.sessionId });
        if (!this.current(state) || state.subscriptions.get(parsed.sessionId) !== intent) return false;
        if (!allowed) { await this.recheckDeniedSession(state, parsed.sessionId); return false; }
        if(!isCurrent())return false;
        return this.write(state, payload);
      });
    });
    const results = await Promise.allSettled(jobs);
    return { sent: results.filter((r) => r.status === 'fulfilled' && r.value === true).length,
      failed: results.filter((r) => r.status === 'rejected').length };
  }
  /** Called only after a Native terminal receipt is confirmed. Never replay its old session status. */
  async broadcastSessionState(sessionId:string,options:{readSession:CoreStoragePort['readSession'];readFrontendSync:CoreStoragePort['readFrontendSync'];
    isCurrent:()=>boolean;present:(session:Awaited<ReturnType<CoreStoragePort['readSession']>> & {})=>NonNullable<Awaited<ReturnType<CoreStoragePort['readSession']>>>}){
    if(!uuid.safeParse(sessionId).success)throw new Error('FRONTEND_SESSION_ID_INVALID');
    const outcomes=await Promise.allSettled([...this.connections.values()].map(state=>{
      const intent=state.subscriptions.get(sessionId);
      if(intent)intent.durable++;
      const current=()=>this.current(state)&&options.isCurrent()&&state.subscriptions.get(sessionId)===intent;
      return this.enqueue(state,512*1024,async()=>{
        if(!current()||!await this.authorized(state,{kind:'session',id:sessionId}))return false;
        if(!current())return false;
        const context=this.syncContext(state);
        if(!intent){
          const access=await options.readFrontendSync({...context,runtimeSessionIds:[sessionId]});
          if(!current()||!access.sessions.some(session=>session.id===sessionId))return false;
        }
        const session=await options.readSession({principal:context.principal,sessionId});
        if(!session||!current()||!await this.authorized(state,{kind:'session',id:sessionId})||!current())return false;
        const event=FrontendEventSchema.parse({type:'session_updated',sessionId,session:options.present(session)});
        return this.write(state,JSON.stringify(event));
      });
    }));
    return{sent:outcomes.filter(o=>o.status==='fulfilled'&&o.value===true).length,failed:outcomes.filter(o=>o.status==='rejected').length};
  }
  /** Called only after a Native terminal receipt is confirmed. Never replay its old session status. */
  async broadcastTerminal(result:Pick<import('../storage/contracts.js').CoreCommandOutputs['turn.finishFromFact'],'savedMessage'|'revision'> & Partial<Pick<import('../storage/contracts.js').CoreCommandOutputs['turn.finishFromFact'],'decision'>>,options:{
    readSession:CoreStoragePort['readSession'];attachmentAvailability:AttachmentAvailability;isCurrent:()=>boolean;
  }):Promise<{sent:number;failed:number}>{
    if(result.savedMessage.role!=='assistant')throw new Error('FRONTEND_TERMINAL_INVALID');
    const { decision, savedMessage } = result;
    const requestTurnId = decision?.sessionId === savedMessage.sessionId && (decision.externalTurnId === savedMessage.turnId || decision.attemptId === savedMessage.turnId) ? decision.attemptId : undefined;
    return this.broadcastMessage(result,{...options,requestTurnId});
  }
  async broadcastMessage(result:Pick<import('../storage/contracts.js').CoreCommandOutputs['turn.finishFromFact'],'savedMessage'|'revision'>,options:{
    readSession:CoreStoragePort['readSession'];attachmentAvailability:AttachmentAvailability;isCurrent:()=>boolean;requestTurnId?:string;
  }):Promise<{sent:number;failed:number}>{
    options=Object.freeze({...options});
    const record=result.savedMessage,sessionId=record.sessionId;
    if(!uuid.safeParse(sessionId).success)throw new Error('FRONTEND_MESSAGE_INVALID');
    const message=presentMessage({id:record.id,session_id:sessionId,turn_id:record.turnId,role:record.role,content:record.content,phase:record.phase,
      items:record.items,metadata:record.metadata,created_at:record.createdAt,duration:record.durationMs,stopped:Number(record.stopped)},
      {attachmentAvailability:this.loadAttachmentAvailability?()=>false:options.attachmentAvailability});
    if (options.requestTurnId) message.requestTurnId = options.requestTurnId;
    const saved=JSON.stringify(FrontendEventSchema.parse({type:'message_saved',sessionId,messageRevision:result.revision,message}));
    let prepared:Promise<string>|undefined;
    const prepareSaved=()=>prepared??=(async()=>{
      if(!this.loadAttachmentAvailability||!message.attachments?.some(attachment=>attachment.kind==='uploaded_file'))return saved;
      const availability=await this.loadAttachmentAvailability(message.attachments.filter(attachment=>attachment.kind==='uploaded_file').map(attachment=>attachment.path));
      return JSON.stringify(FrontendEventSchema.parse({type:'message_saved',sessionId,messageRevision:result.revision,
        message:{...message,attachments:message.attachments.map(attachment=>attachment.kind==='uploaded_file'?{...attachment,available:availability(attachment.path)}:attachment)}}));
    })();
    const bytes=Buffer.byteLength(saved)+512*1024;
    if(!options.isCurrent())return{sent:0,failed:0};
    const jobs=[...this.connections.values()].filter(state=>state.client.subscribedSessionIds.has(sessionId)).map(state=>{
      const intent=state.subscriptions.get(sessionId);if(intent)intent.durable++;
      const current=()=>options.isCurrent()&&this.current(state)&&state.subscriptions.get(sessionId)===intent;
      return this.enqueue(state,bytes,async()=>{
        if(!current())return false;
        if(!await this.authorized(state,{kind:'session',id:sessionId})){
          if(current())await this.recheckDeniedSession(state,sessionId);return false;
        }
        const output=await prepareSaved();
        if(this.loadAttachmentAvailability&&!await this.authorized(state,{kind:'session',id:sessionId})){
          if(current())await this.recheckDeniedSession(state,sessionId);return false;
        }
        if(!current()||!await this.write(state,output)||!current())return false;
        const principal={kind:'user' as const,userId:state.userId,authSessionHash:state.tokenHash};
        const session=await options.readSession({principal,sessionId});
        if(!current())return false;
        if(!await this.authorized(state,{kind:'session',id:sessionId})||!session){
          if(current())await this.recheckDeniedSession(state,sessionId);return false;
        }
        if(!current())return false;
        if(session.id!==sessionId)throw new Error('FRONTEND_TERMINAL_INVALID');
        const updated=FrontendEventSchema.parse({type:'session_updated',sessionId,session});
        canonicalJson(updated,512*1024);return this.write(state,JSON.stringify(updated));
      });
    });
    const outcomes=await Promise.allSettled(jobs);
    return{sent:outcomes.filter(outcome=>outcome.status==='fulfilled'&&outcome.value===true).length,failed:outcomes.filter(outcome=>outcome.status==='rejected').length};
  }
  async broadcastTrust(event: TrustEvent, userId: string): Promise<void> {
    const validated = FrontendEventSchema.parse(event);
    if (validated.type !== 'approval_trust_updated') throw new Error('FRONTEND_TRUST_EVENT_INVALID');
    const parsed = validated;
    const payload = JSON.stringify(parsed);
    const results = await Promise.allSettled([...this.connections.values()].filter((s) => s.userId === userId).map((state) =>
      this.enqueue(state, Buffer.byteLength(payload), async () => {
        if (!await this.authorized(state, { kind: parsed.scope, id: parsed.scopeId })) return false;
        return this.write(state, payload);
      })));
    if (results.some((r) => r.status === 'rejected')) throw new Error('FRONTEND_NOTIFICATION_UNAVAILABLE');
  }
  /** Per-recipient loading avoids publishing stale command values or another user's private receipt. */
  async broadcastSessionRead(userId:string,sessionId:string,load:(principal:SyncContext['principal'])=>Promise<{messageId:string|null}>):Promise<void>{
    if(!uuid.safeParse(sessionId).success)throw new Error('FRONTEND_SESSION_EVENT_INVALID');
    const results=await Promise.allSettled([...this.connections.values()].filter(s=>s.userId===userId).map(state=>
      this.enqueue(state,1024,async()=>{
        if(!await this.authorized(state,{kind:'session',id:sessionId}))return false;
        const receipt=await load({kind:'user',userId:state.userId,authSessionHash:state.tokenHash});
        if(!receipt.messageId||!this.current(state)||!await this.authorized(state,{kind:'session',id:sessionId}))return false;
        const event=FrontendEventSchema.parse({type:'session_reads',receipts:{[sessionId]:receipt.messageId}});
        return this.write(state,JSON.stringify(event));
      })));
    if(results.some(r=>r.status==='rejected'))throw new Error('FRONTEND_NOTIFICATION_UNAVAILABLE');
  }
  dispose(): void { for (const state of [...this.connections.values()]) this.remove(state.client); }
  async broadcastNotificationPreferences(userId:string,load:(principal:SyncContext['principal'])=>Promise<NotificationPreferencesDto>):Promise<void>{
    const results=await Promise.allSettled([...this.connections.values()].filter(s=>s.userId===userId).map(state=>this.enqueue(state,2048,async()=>{
      if(!await this.authorized(state,null))return false;
      const preferences=await load({kind:'user',userId:state.userId,authSessionHash:state.tokenHash});
      if(!this.current(state)||!await this.authorized(state,null))return false;
      return this.write(state,JSON.stringify(FrontendEventSchema.parse({type:'notification_preferences_updated',preferences})));
    })));
    if(results.some(r=>r.status==='rejected'))throw new Error('FRONTEND_NOTIFICATION_UNAVAILABLE');
  }
  async broadcastThemeSettings(userId:string,load:(principal:SyncContext['principal'])=>Promise<AccountThemeSettingsDto>):Promise<void>{
    const results=await Promise.allSettled([...this.connections.values()].filter(s=>s.userId===userId).map(state=>this.enqueue(state,4096,async()=>{
      if(!await this.authorized(state,null))return false;
      const settings=await load({kind:'user',userId:state.userId,authSessionHash:state.tokenHash});
      if(!this.current(state)||!await this.authorized(state,null))return false;
      return this.write(state,JSON.stringify(FrontendEventSchema.parse({type:'theme_settings_updated',settings})));
    })));
    if(results.some(r=>r.status==='rejected'))throw new Error('FRONTEND_NOTIFICATION_UNAVAILABLE');
  }
}
