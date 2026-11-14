import { RELAY_PROTOCOL_VERSION, type MessagePageDto } from '../generated/relay-contracts.ts';
import {
  MESSAGE_CACHE_SESSION_BYTES,
  MESSAGE_CACHE_TTL_MS,
  createMessageCacheKey,
  estimateCacheBytes,
  isCompatibleMessageCachePage,
  sanitizeMessagePage,
  selectCacheRecordsToKeep,
  type CachedMessagePage,
} from './message-cache-policy.ts';

const DB_NAME = 'relay-message-cache-v1';
const STORE_NAME = 'message-pages';
const DB_VERSION = 1;
const CACHE_OWNER_KEY = 'relay:message-cache-owner';
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

interface MessageCacheRecord {
  key: string;
  userId: string;
  protocolVersion: number;
  sessionId: string;
  page: CachedMessagePage;
  sizeBytes: number;
  createdAt: number;
  lastAccessedAt: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已取消'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
  });
}

async function openMessageCache(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    return await requestResult(request);
  } catch {
    return null;
  }
}

export async function readMessageCache(userId: string, sessionId: string): Promise<MessagePageDto | null> {
  const database = await openMessageCache();
  if (!database) return null;
  const key = createMessageCacheKey(userId, RELAY_PROTOCOL_VERSION, sessionId);
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const record = await requestResult(store.get(key)) as MessageCacheRecord | undefined;
    if (!record
      || record.userId !== userId
      || record.protocolVersion !== RELAY_PROTOCOL_VERSION
      || record.sessionId !== sessionId
      || !isCompatibleMessageCachePage(record.page)
      || Date.now() - record.createdAt > MESSAGE_CACHE_TTL_MS
      || record.sizeBytes > MESSAGE_CACHE_SESSION_BYTES) {
      if (record) store.delete(key);
      await transactionDone(transaction);
      return null;
    }
    record.lastAccessedAt = Date.now();
    store.put(record);
    await transactionDone(transaction);
    return record.page as MessagePageDto;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export async function writeMessageCache(userId: string, page: MessagePageDto): Promise<void> {
  const database = await openMessageCache();
  if (!database) return;
  try {
    const sanitizedPage = sanitizeMessagePage(page);
    const now = Date.now();
    const key = createMessageCacheKey(userId, RELAY_PROTOCOL_VERSION, page.sessionId);
    const record: MessageCacheRecord = {
      key,
      userId,
      protocolVersion: RELAY_PROTOCOL_VERSION,
      sessionId: page.sessionId,
      page: sanitizedPage,
      sizeBytes: estimateCacheBytes(sanitizedPage),
      createdAt: now,
      lastAccessedAt: now,
    };
    if (record.sizeBytes > MESSAGE_CACHE_SESSION_BYTES) return;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const existing = await requestResult(store.getAll()) as MessageCacheRecord[];
    const candidates = [record, ...existing.filter((item) => (
      item.key !== key
      && item.userId === userId
      && item.protocolVersion === RELAY_PROTOCOL_VERSION
    ))];
    const keptKeys = new Set(selectCacheRecordsToKeep(candidates, now).map((item) => item.key));
    for (const item of existing) {
      if (!keptKeys.has(item.key)) store.delete(item.key);
    }
    if (keptKeys.has(key)) store.put(record);
    await transactionDone(transaction);
  } catch {
    // 缓存不可用或 quota 失败时按 cache miss 处理。
  } finally {
    database.close();
  }
}

export function scheduleMessageCacheWrite(userId: string, page: MessagePageDto, delayMs = 300): void {
  const key = createMessageCacheKey(userId, RELAY_PROTOCOL_VERSION, page.sessionId);
  const current = pendingWrites.get(key);
  if (current) clearTimeout(current);
  pendingWrites.set(key, setTimeout(() => {
    pendingWrites.delete(key);
    void writeMessageCache(userId, page);
  }, delayMs));
}

export async function clearMessageCache(): Promise<void> {
  for (const timer of pendingWrites.values()) clearTimeout(timer);
  pendingWrites.clear();
  const database = await openMessageCache();
  if (!database) return;
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    await transactionDone(transaction);
  } catch {
    // 清理失败不影响退出或重新认证。
  } finally {
    database.close();
  }
}

export async function activateMessageCacheUser(userId: string): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  try {
    const owner = `${userId}:${RELAY_PROTOCOL_VERSION}`;
    const previousOwner = localStorage.getItem(CACHE_OWNER_KEY);
    if (previousOwner !== owner) await clearMessageCache();
    localStorage.setItem(CACHE_OWNER_KEY, owner);
  } catch {
    // 本地存储不可用时不阻断认证。
  }
}

export function clearMessageCacheOwner(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(CACHE_OWNER_KEY);
  } catch {
    // 本地存储不可用时不阻断退出。
  }
}
