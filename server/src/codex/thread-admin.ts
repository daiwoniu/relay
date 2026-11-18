import WebSocket from 'ws';
import { resolveCodexEndpoint } from './endpoint.js';
import { selectSubAgentReport } from './sub-agent-report.js';

const ARCHIVE_CACHE_TTL_MS = 15_000;
const RPC_TIMEOUT_MS = 10_000;

type RpcRequest = (method: string, params?: Record<string, unknown>) => Promise<any>;

interface RpcClient {
  request: RpcRequest;
  notify: (method: string, params?: Record<string, unknown>) => void;
  close: () => void;
}

export interface ArchivedThreadCache {
  read(): Set<string> | null;
  refresh(options?: { force?: boolean }): Promise<Set<string>>;
  refreshInBackground(options?: {
    onSuccess?: (threadIds: Set<string>) => void;
    onError?: (error: Error) => void;
  }): boolean;
  clear(): void;
}

export function createArchivedThreadCache(
  load: () => Promise<Set<string>>,
  options: { now?: () => number; ttlMs?: number } = {},
): ArchivedThreadCache {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ARCHIVE_CACHE_TTL_MS;
  let entry: { refreshedAt: number; threadIds: Set<string> } | null = null;
  let generation = 0;
  let request: { generation: number; promise: Promise<Set<string>> } | null = null;

  const read = () => entry ? new Set(entry.threadIds) : null;
  const isFresh = () => Boolean(entry && entry.refreshedAt + ttlMs > now());
  const refresh = async ({ force = false }: { force?: boolean } = {}): Promise<Set<string>> => {
    if (!force && isFresh()) return read()!;
    if (force && request?.generation === generation) generation += 1;
    const requestGeneration = generation;
    if (!request || request.generation !== requestGeneration) {
      const nextRequest = { generation: requestGeneration, promise: Promise.resolve(new Set<string>()) };
      nextRequest.promise = load()
        .then((threadIds) => {
          if (generation === requestGeneration) {
            entry = { refreshedAt: now(), threadIds: new Set(threadIds) };
          }
          return new Set(threadIds);
        })
        .finally(() => {
          if (request === nextRequest) request = null;
        });
      request = nextRequest;
    }
    return new Set(await request.promise);
  };

  return {
    read,
    refresh,
    refreshInBackground(backgroundOptions = {}) {
      if (isFresh() || request?.generation === generation) return false;
      const backgroundGeneration = generation;
      const reportError = (error: unknown) => {
        if (generation !== backgroundGeneration) return;
        try {
          backgroundOptions.onError?.(error instanceof Error ? error : new Error(String(error)));
        } catch {
          // 后台诊断回调不能反向形成未处理拒绝。
        }
      };
      void refresh({ force: true }).then((threadIds) => {
        if (generation !== backgroundGeneration) return;
        try {
          backgroundOptions.onSuccess?.(threadIds);
        } catch (error) {
          reportError(error);
        }
      }, reportError);
      return true;
    },
    clear() {
      generation += 1;
      entry = null;
    },
  };
}

async function openRpcClient(maxPayload?: number): Promise<RpcClient> {
  const ws = new WebSocket(resolveCodexEndpoint().wsUrl, maxPayload === undefined ? {} : { maxPayload });
  let requestId = 0;
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const rejectPending = () => {
    for (const callback of pending.values()) {
      clearTimeout(callback.timer);
      callback.reject(new Error('Codex 管理连接已断开'));
    }
    pending.clear();
  };
  ws.on('error', rejectPending);
  ws.on('close', rejectPending);

  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString());
    if (message.id === undefined || !pending.has(message.id)) return;
    const callback = pending.get(message.id)!;
    pending.delete(message.id);
    clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(message.error.message || 'Codex RPC error'));
    else callback.resolve(message.result);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 Codex app-server 超时')), RPC_TIMEOUT_MS);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const request: RpcRequest = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex RPC 超时：${method}`));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const client: RpcClient = {
    request,
    notify: (method, params = {}) => ws.send(JSON.stringify({ method, params })),
    close: () => {
      for (const callback of pending.values()) {
        clearTimeout(callback.timer);
        callback.reject(new Error('Codex 管理连接已关闭'));
      }
      pending.clear();
      ws.close();
    },
  };

  try {
    await client.request('initialize', {
      clientInfo: { name: 'relay', title: 'Relay Browser Client', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function collectArchivedThreadIds(request: RpcRequest): Promise<Set<string>> {
  const threadIds = new Set<string>();
  const visited = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    if (++pages > 1000) throw new Error('ARCHIVE_SNAPSHOT_TOO_LARGE');
    const result = await request('thread/list', {
      cursor,
      limit: 100,
      sortKey: 'updated_at',
      archived: true,
    });
    if (!result || !Array.isArray(result.data) || result.data.some((thread: any) => typeof thread?.id !== 'string' || !thread.id || thread.id.length > 256)
      || result.nextCursor !== undefined && result.nextCursor !== null && typeof result.nextCursor !== 'string') throw new Error('ARCHIVE_SNAPSHOT_INVALID');
    for (const thread of result.data) {
      threadIds.add(thread.id);
    }
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    if (cursor) { if (visited.has(cursor)) throw new Error('ARCHIVE_SNAPSHOT_CURSOR_REPEATED'); visited.add(cursor); }
  } while (cursor);
  return threadIds;
}

export async function requestThreadUnarchive(threadId: string, request: RpcRequest): Promise<void> {
  await request('thread/unarchive', { threadId });
}

export interface BatchThreadUnarchiveResult {
  succeeded: string[];
  failed: Array<{ threadId: string; message: string }>;
}

export async function requestThreadsUnarchive(threadIds: string[], request: RpcRequest): Promise<BatchThreadUnarchiveResult> {
  const result: BatchThreadUnarchiveResult = { succeeded: [], failed: [] };
  for (const threadId of threadIds) {
    try {
      await requestThreadUnarchive(threadId, request);
      result.succeeded.push(threadId);
    } catch (error) {
      result.failed.push({ threadId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export async function requestThreadArchive(threadId: string, request: RpcRequest): Promise<void> {
  await request('thread/archive', { threadId });
}

/** The caller owns a durable dispatch right; this check is adjacent to the provider write. */
export async function requestThreadArchiveGuarded(threadId:string,request:RpcRequest,mayDispatch:()=>Promise<boolean>):Promise<void>{
  if(!await mayDispatch())throw new Error('ARCHIVE_AUTHORITY_CHANGED');
  await requestThreadArchive(threadId,request);
}

export async function requestThreadFork(
  threadId: string,
  lastTurnId: string | undefined,
  request: RpcRequest,
): Promise<string> {
  const result = await request('thread/fork', { threadId, ...(lastTurnId ? { lastTurnId } : {}) });
  const forkedThreadId = result?.thread?.id;
  if (typeof forkedThreadId !== 'string' || !forkedThreadId) {
    throw new Error('Codex 未返回新会话标识');
  }
  return forkedThreadId;
}

async function loadArchivedCodexThreadIds(): Promise<Set<string>> {
  const client = await openRpcClient();
  try {
    return await collectArchivedThreadIds(client.request);
  } finally {
    client.close();
  }
}

const archivedThreadCache = createArchivedThreadCache(loadArchivedCodexThreadIds);

export async function getArchivedCodexThreadIds(options: { force?: boolean } = {}): Promise<Set<string>> {
  return archivedThreadCache.refresh(options);
}

export function getCachedArchivedCodexThreadIds(): Set<string> | null {
  return archivedThreadCache.read();
}

export function refreshArchivedCodexThreadIdsInBackground(options: {
  onSuccess?: (threadIds: Set<string>) => void;
  onError?: (error: Error) => void;
} = {}): boolean {
  return archivedThreadCache.refreshInBackground(options);
}

export function invalidateArchivedThreadCache(): void {
  archivedThreadCache.clear();
}

export async function unarchiveCodexThread(threadId: string): Promise<void> {
  const client = await openRpcClient();
  try {
    await requestThreadUnarchive(threadId, client.request);
    invalidateArchivedThreadCache();
  } finally {
    client.close();
  }
}

/** Native-store caller supplies a current-principal/source fence after asynchronous provider setup. */
export async function unarchiveCodexThreadGuarded(threadId: string, mayDispatch: () => Promise<boolean>): Promise<void> {
  const client = await openRpcClient();
  try {
    if (!await mayDispatch()) throw new Error('UNARCHIVE_AUTHORITY_CHANGED');
    await requestThreadUnarchive(threadId, client.request);
    invalidateArchivedThreadCache();
  } finally { client.close(); }
}

/** Bypass both TTL and an older shared cache refresh when proving an ambiguous external action. */
export async function isCodexThreadArchivedFresh(threadId: string): Promise<boolean> {
  return(await listArchivedCodexThreadIdsFresh()).has(threadId);
}
export async function listArchivedCodexThreadIdsFresh():Promise<Set<string>>{
  const client = await openRpcClient();
  try { return await collectArchivedThreadIds(client.request); }
  finally { client.close(); }
}

export async function unarchiveCodexThreads(threadIds: string[]): Promise<BatchThreadUnarchiveResult> {
  if (threadIds.length === 0) return { succeeded: [], failed: [] };
  const client = await openRpcClient();
  try {
    const result = await requestThreadsUnarchive(threadIds, client.request);
    if (result.succeeded.length > 0) invalidateArchivedThreadCache();
    return result;
  } finally {
    client.close();
  }
}

export async function archiveCodexThread(threadId: string): Promise<void> {
  const client = await openRpcClient();
  try {
    await requestThreadArchive(threadId, client.request);
    invalidateArchivedThreadCache();
  } finally {
    client.close();
  }
}

export async function readCodexSubAgentReport(childThreadId: string, completionItemId: string): Promise<string | null> {
  const client = await openRpcClient(32 * 1024 * 1024);
  try {
    const result = await client.request('thread/read', { threadId: childThreadId, includeTurns: true });
    return selectSubAgentReport(result?.thread, childThreadId, completionItemId);
  } finally { client.close(); }
}

export async function archiveCodexThreadGuarded(threadId:string,mayDispatch:()=>Promise<boolean>):Promise<void>{
  const client=await openRpcClient();
  try{await requestThreadArchiveGuarded(threadId,client.request,mayDispatch);invalidateArchivedThreadCache();}
  finally{client.close();}
}

export async function forkCodexThreadGuarded(threadId: string, lastTurnId: string | undefined, mayDispatch: () => Promise<boolean>): Promise<string> {
  const client = await openRpcClient();
  try {
    if (!await mayDispatch()) throw new Error('FORK_AUTHORITY_CHANGED');
    return await requestThreadFork(threadId, lastTurnId, client.request);
  } finally { client.close(); }
}

export async function forkCodexThread(threadId: string, lastTurnId?: string): Promise<string> {
  const client = await openRpcClient();
  try {
    return await requestThreadFork(threadId, lastTurnId, client.request);
  } finally {
    client.close();
  }
}

export async function confirmThreadArchived(
  threadId: string,
  archiveThread: (threadId: string) => Promise<void>,
  listArchivedThreadIds: () => Promise<Set<string>>,
): Promise<void> {
  try {
    await archiveThread(threadId);
  } catch (error) {
    if ((await listArchivedThreadIds()).has(threadId)) return;
    throw error;
  }
}

export async function confirmThreadArchivedWithState(
  threadId: string,
  archiveThread: (threadId: string) => Promise<void>,
  listArchivedThreadIds: () => Promise<Set<string>>,
): Promise<{ wasAlreadyArchived: boolean }> {
  if ((await listArchivedThreadIds()).has(threadId)) return { wasAlreadyArchived: true };
  await confirmThreadArchived(threadId, archiveThread, listArchivedThreadIds);
  return { wasAlreadyArchived: false };
}

export async function ensureCodexThreadArchived(threadId: string): Promise<void> {
  await confirmThreadArchived(
    threadId,
    archiveCodexThread,
    () => getArchivedCodexThreadIds({ force: true }),
  );
}

export interface CodexDeletionLifecycleDependencies {
  ensureReady: () => Promise<boolean | void>;
  releaseReady: () => void;
  archiveThread?: (threadId: string) => Promise<void>;
  listArchivedThreadIds?: () => Promise<Set<string>>;
}

export async function ensureCodexThreadArchivedForDeletion(
  threadId: string,
  dependencies: CodexDeletionLifecycleDependencies,
): Promise<{ wasAlreadyArchived: boolean }> {
  const {ensureReady,releaseReady}=dependencies;
  const woke = (await ensureReady()) === true;
  try {
    return await confirmThreadArchivedWithState(
      threadId,
      dependencies.archiveThread ?? archiveCodexThread,
      dependencies.listArchivedThreadIds ?? (() => getArchivedCodexThreadIds({ force: true })),
    );
  } finally {
    if (woke) releaseReady();
  }
}
