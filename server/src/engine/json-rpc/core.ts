import type {
  JsonRpcEnvelope,
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcTransport,
} from '../transports/transport.js';

export class JsonRpcRemoteError extends Error {
  constructor(
    message: string,
    readonly rpcCode: number | null,
    readonly rpcData: any,
  ) {
    super(message);
    this.name = 'JsonRpcRemoteError';
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} 请求超时（${timeoutMs}ms）`);
    this.name = 'JsonRpcTimeoutError';
  }
}

export class JsonRpcConnectionClosedError extends Error {
  constructor(message = 'JSON-RPC 连接已断开') {
    super(message);
    this.name = 'JsonRpcConnectionClosedError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface JsonRpcCoreOptions {
  defaultTimeoutMs: number;
  createRemoteError?: (error: JsonRpcErrorObject) => Error;
  createTimeoutError?: (method: string, timeoutMs: number) => Error;
  createConnectionClosedError?: () => Error;
}

export interface JsonRpcRequestOptions {
  timeoutMs?: number | null;
  onSent?: () => void;
}

export class JsonRpcCore {
  private requestId = 0;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly serverRequestListeners = new Set<(message: JsonRpcEnvelope) => void>();
  private readonly notificationListeners = new Set<(message: JsonRpcEnvelope) => void>();
  private readonly unknownMessageListeners = new Set<(message: JsonRpcEnvelope) => void>();

  constructor(
    readonly transport: JsonRpcTransport,
    private readonly options: JsonRpcCoreOptions,
  ) {
    transport.onMessage((message) => this.handleMessage(message));
    transport.onClose(() => this.rejectAll(this.connectionClosedError()));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  request<T = unknown>(
    method: string,
    params: unknown = {},
    options: JsonRpcRequestOptions = {},
  ): Promise<T> {
    const id = ++this.requestId;
    const timeoutMs = options.timeoutMs === undefined ? this.options.defaultTimeoutMs : options.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(this.options.createTimeoutError?.(method, timeoutMs)
          ?? new JsonRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.transport.send({ jsonrpc: '2.0', id, method, params });
        options.onSent?.();
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.transport.send({ jsonrpc: '2.0', method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.transport.send({ jsonrpc: '2.0', id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.transport.send({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  onServerRequest(listener: (message: JsonRpcEnvelope) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onNotification(listener: (message: JsonRpcEnvelope) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onUnknownMessage(listener: (message: JsonRpcEnvelope) => void): () => void {
    this.unknownMessageListeners.add(listener);
    return () => this.unknownMessageListeners.delete(listener);
  }

  rejectAll(error: Error = this.connectionClosedError()): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(): void {
    this.rejectAll();
    this.transport.close();
  }

  private handleMessage(message: JsonRpcEnvelope): void {
    if (message.method && message.id !== undefined) {
      for (const listener of this.serverRequestListeners) listener(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        for (const listener of this.unknownMessageListeners) listener(message);
        return;
      }
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(this.options.createRemoteError?.(message.error)
          ?? new JsonRpcRemoteError(
            message.error.message || 'JSON-RPC error',
            typeof message.error.code === 'number' ? message.error.code : null,
            message.error.data,
          ));
      } else {
        pending.resolve(Object.prototype.hasOwnProperty.call(message, 'result') ? message.result : message);
      }
      return;
    }
    if (message.method) {
      for (const listener of this.notificationListeners) listener(message);
      return;
    }
    for (const listener of this.unknownMessageListeners) listener(message);
  }

  private connectionClosedError(): Error {
    return this.options.createConnectionClosedError?.() ?? new JsonRpcConnectionClosedError();
  }
}
