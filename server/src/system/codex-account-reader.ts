import WebSocket from 'ws';
import { resolveCodexEndpoint } from '../codex/endpoint.js';
import type { CodexAccountSnapshotDto } from '../contracts/index.js';
export type RpcClient={request(method:string,params?:Record<string,unknown>):Promise<any>;close():void|Promise<void>};
export interface CodexAccountReaderOptions{ensureReady:()=>Promise<boolean|void>;releaseReady:()=>void;openRpc?:()=>Promise<RpcClient>;now?:()=>number}
const RPC_TIMEOUT_MS=10_000;
export function accountIdentity(snapshot: Pick<CodexAccountSnapshotDto, 'authMode' | 'email'>): string | null {
  const email = snapshot.email?.trim().toLowerCase();
  return email && snapshot.authMode !== 'unknown' ? `${snapshot.authMode}:${email}` : null;
}

function normalizeAuthMode(type: unknown): CodexAccountSnapshotDto['authMode'] {
  if (type === 'chatgpt' || type === 'chatgptAuthTokens' || type === 'apiKey' || type === 'amazonBedrock') {
    return type === 'apiKey' ? 'apikey' : type;
  }
  return 'unknown';
}

function normalizeRateLimits(result: any): CodexAccountSnapshotDto['rateLimits'] {
  const buckets = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
    ? Object.values(result.rateLimitsByLimitId)
    : result?.rateLimits ? [result.rateLimits] : [];
  return buckets.flatMap((bucket: any) => {
    if (!bucket || typeof bucket !== 'object' || typeof bucket.limitId !== 'string') return [];
    return (['primary', 'secondary'] as const).flatMap((windowType) => {
      const window = bucket[windowType] && typeof bucket[windowType] === 'object' ? bucket[windowType] : null;
      if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return [];
      return [{
        limitId: bucket.limitId,
        limitName: typeof bucket.limitName === 'string' ? bucket.limitName : null,
        windowType,
        usedPercent: window.usedPercent,
        windowDurationMins: Number.isInteger(window.windowDurationMins) ? window.windowDurationMins : null,
        resetsAt: Number.isInteger(window.resetsAt) ? window.resetsAt : null,
        normalModelSlug: typeof bucket.normalModelSlug === 'string' ? bucket.normalModelSlug : null,
        rateLimitReachedType: typeof bucket.rateLimitReachedType === 'string' ? bucket.rateLimitReachedType : null,
        spendControlReached: bucket.spendControlReached === true,
      }];
    });
  }).sort((left, right) => Number(right.limitId === 'codex') - Number(left.limitId === 'codex') || Number(left.windowType !== 'primary') - Number(right.windowType !== 'primary'));
}

function normalizeCredits(result: any): CodexAccountSnapshotDto['credits'] {
  const codexBucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const credits = codexBucket?.credits ?? result?.credits;
  if (!credits || typeof credits !== 'object') return null;
  const parsedBalance = typeof credits.balance === 'string' && credits.balance.trim() !== '' ? Number(credits.balance) : null;
  const remaining = typeof credits.remaining === 'number' ? credits.remaining : typeof credits.balance === 'number' ? credits.balance : Number.isFinite(parsedBalance) ? parsedBalance : null;
  const currency = typeof credits.currency === 'string' ? credits.currency : null;
  return { remaining, currency, hasCredits: credits.hasCredits === true, unlimited: credits.unlimited === true };
}

function normalizeResetCredits(value: any): CodexAccountSnapshotDto['rateLimitResetCredits'] {
  if (!Number.isInteger(value?.availableCount) || value.availableCount < 0) return null;
  const credits = Array.isArray(value.credits) ? value.credits
    .filter((credit: any) => credit?.status === 'available' && credit.resetType === 'codexRateLimits')
    .slice(0, 20)
    .map((credit: any) => ({
      id: typeof credit.id === 'string' && credit.id.length > 0 && credit.id.length <= 256 ? credit.id : null,
      title: typeof credit.title === 'string' ? credit.title.slice(0, 80) : null,
      expiresAt: Number.isInteger(credit.expiresAt) && credit.expiresAt >= 0 ? credit.expiresAt : null,
    })) : null;
  return { availableCount: value.availableCount, credits };
}

function normalizeUsage(result: any): CodexAccountSnapshotDto['usage'] {
  const summary = result?.summary;
  if (!summary || typeof summary !== 'object') return null;
  return {
    lifetimeTokens: Number.isInteger(summary.lifetimeTokens) ? summary.lifetimeTokens : null,
    peakDailyTokens: Number.isInteger(summary.peakDailyTokens) ? summary.peakDailyTokens : null,
    longestRunningTurnSec: Number.isInteger(summary.longestRunningTurnSec) && summary.longestRunningTurnSec >= 0 ? summary.longestRunningTurnSec : null,
    currentStreakDays: Number.isInteger(summary.currentStreakDays) && summary.currentStreakDays >= 0 ? summary.currentStreakDays : null,
    longestStreakDays: Number.isInteger(summary.longestStreakDays) && summary.longestStreakDays >= 0 ? summary.longestStreakDays : null,
    dailyUsageBuckets: Array.isArray(result.dailyUsageBuckets)
      ? result.dailyUsageBuckets
        .filter((bucket: any) => typeof bucket?.startDate === 'string' && Number.isInteger(bucket?.tokens) && bucket.tokens >= 0)
        .slice(-366)
        .map((bucket: any) => ({ startDate: bucket.startDate, tokens: bucket.tokens }))
      : [],
  };
}

export async function openCodexAccountRpcClient(options:{url?:string;timeoutMs?:number}={}): Promise<RpcClient> {
  const timeoutMs=options.timeoutMs??RPC_TIMEOUT_MS;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('CODEX_ACCOUNT_RPC_INVALID_TIMEOUT');
  const ws = new WebSocket(options.url??resolveCodexEndpoint().wsUrl,{maxPayload:4*1024*1024});
  let requestId = 0;
  let closed=false;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const rejectPending=()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('CODEX_ACCOUNT_RPC_UNAVAILABLE'));}pending.clear();};
  const exited=new Promise<void>(resolve=>ws.once('close',()=>{closed=true;rejectPending();resolve();}));
  const close=async()=>{closed=true;rejectPending();if(ws.readyState!==WebSocket.CLOSED)ws.terminate();await exited;};
  ws.on('error',()=>{closed=true;rejectPending();if(ws.readyState!==WebSocket.CLOSED)ws.terminate();});
  ws.on('message', (raw: Buffer) => {
    let message:any;
    try{message=JSON.parse(raw.toString());if(!message||typeof message!=='object'||Array.isArray(message))throw Error();}
    catch{void close();return;}
    if (!Number.isSafeInteger(message.id) || !pending.has(message.id)) return;
    const callback = pending.get(message.id)!;
    pending.delete(message.id); clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error('CODEX_ACCOUNT_RPC_REJECTED')); else callback.resolve(message.result);
  });
  try{await new Promise<void>((resolve, reject) => {
    const finish=(ok:boolean)=>{clearTimeout(timer);ws.off('open',open);ws.off('error',failed);ws.off('close',failed);if(ok)resolve();else reject(Error('CODEX_ACCOUNT_RPC_UNAVAILABLE'));};
    const open=()=>finish(true),failed=()=>finish(false);
    const timer = setTimeout(failed, timeoutMs);timer.unref();
    ws.once('open', open);ws.once('error', failed);ws.once('close',failed);
  });}catch(error){await close();throw error;}
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    if(closed||ws.readyState!==WebSocket.OPEN)return reject(Error('CODEX_ACCOUNT_RPC_UNAVAILABLE'));
    if(pending.size>=8)return reject(Error('CODEX_ACCOUNT_RPC_OVERLOADED'));
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CODEX_ACCOUNT_RPC_TIMEOUT')); }, timeoutMs);timer.unref();
    pending.set(id, { resolve, reject, timer });
    try{ws.send(JSON.stringify({ id, method, params }),error=>{if(error)void close();});}catch{void close();}
  });
  const client = { request, close };
  try {
    await client.request('initialize', { clientInfo: { name: 'relay', title: 'Relay Browser Client', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    return client;
  } catch (error) { await client.close(); throw error; }
}


/** Provider I/O only. Snapshot persistence and mutation intent ownership belong to the caller. */
export function createCodexAccountReader(options:CodexAccountReaderOptions){
  const {ensureReady,releaseReady}=options,openRpc=options.openRpc??openCodexAccountRpcClient,now=options.now??Date.now;
  const readSnapshot = async (verifyIdentity=false): Promise<{ snapshot: CodexAccountSnapshotDto; limitsOk: boolean; usageOk: boolean }> => {
      let rpc: RpcClient | null = null;
      let woke = false;
      try {
        woke = (await ensureReady()) === true;
        rpc = await openRpc();
        const accountResult = await rpc.request('account/read', { refreshToken: false });
        const [limits, usage] = await Promise.allSettled([
          rpc.request('account/rateLimits/read'),
          rpc.request('account/usage/read'),
        ]);
        const limitsResult = limits.status === 'fulfilled' ? limits.value : null;
        const usageResult = usage.status === 'fulfilled' ? usage.value : null;
        const account = accountResult?.account || {};
        if(verifyIdentity){const after=(await rpc.request('account/read',{refreshToken:false}))?.account??{};
          const identity=(value:any)=>accountIdentity({authMode:normalizeAuthMode(value.type),email:typeof value.email==='string'?value.email:null});
          if(identity(account)!==identity(after))throw new Error('CODEX_ACCOUNT_IDENTITY_CHANGED');
        }
        return { limitsOk: limits.status === 'fulfilled', usageOk: usage.status === 'fulfilled', snapshot: {
          fetchedAt: now(),
          status: 'ready',
          authMode: normalizeAuthMode(account.type),
          email: typeof account.email === 'string' ? account.email : null,
          planType: typeof account.planType === 'string' ? account.planType : null,
          rateLimits: normalizeRateLimits(limitsResult),
          credits: normalizeCredits(limitsResult),
          rateLimitResetCredits: normalizeResetCredits(limitsResult?.rateLimitResetCredits),
          usage: normalizeUsage(usageResult),
          errorMessage: null,
        } };
      } catch {
        return { limitsOk: false, usageOk: false, snapshot: { fetchedAt: now(), status: 'unavailable', authMode: 'unknown', email: null, planType: null, rateLimits: [], credits: null, rateLimitResetCredits: null, usage: null, errorMessage: 'Codex 账号额度暂时无法读取' } };
      } finally { try{await rpc?.close();}finally{if(woke)releaseReady();} }
  };
  return{readSnapshot,async consumeResetCredit(params:{idempotencyKey:string;creditId?:string},context?:{expectedIdentityKey:string;mayDispatch:()=>Promise<boolean>}):Promise<'reset'|'nothingToReset'|'noCredit'|'alreadyRedeemed'>{
    let rpc:RpcClient|null=null,woke=false;
    try{woke=(await ensureReady())===true;rpc=await openRpc();
      if(context){
        const account=(await rpc.request('account/read',{refreshToken:false}))?.account??{};
        if(accountIdentity({authMode:normalizeAuthMode(account.type),email:typeof account.email==='string'?account.email:null})!==context.expectedIdentityKey)throw new Error('CODEX_ACCOUNT_IDENTITY_CHANGED');
        if(!await context.mayDispatch())throw new Error('CREDIT_RESET_AUTHORITY_CHANGED');
      }
        const result = await rpc.request('account/rateLimitResetCredit/consume', params);
        if (!['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(result?.outcome)) {
          throw new Error('invalid reset outcome');
        }
      return result.outcome;
    }finally{try{await rpc?.close();}finally{if(woke)releaseReady();}}
  }};
}
