import WebSocket from 'ws';
import type {
  JsonRpcEnvelope,
  JsonRpcTransport,
  JsonRpcTransportState,
} from './transport.js';

export class WebSocketTransportParseError extends Error {
  constructor(readonly preview: string) {
    super('WebSocket 收到无效 JSON-RPC 消息');
    this.name = 'WebSocketTransportParseError';
  }
}

export class WebSocketJsonRpcTransport implements JsonRpcTransport {
  private readonly socket: WebSocket;
  private readonly physicallyClosed: Promise<void>;
  private readonly openListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: JsonRpcEnvelope) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.physicallyClosed = new Promise(resolve => this.socket.once('close', () => resolve()));
    this.socket.on('open', () => {
      for (const listener of this.openListeners) listener();
    });
    this.socket.on('message', (data) => {
      const raw = data.toString();
      try {
        const message = JSON.parse(raw) as JsonRpcEnvelope;
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw new Error('JSON-RPC 信封必须是对象');
        }
        for (const listener of this.messageListeners) listener(message);
      } catch {
        const error = new WebSocketTransportParseError(raw.slice(0, 200));
        for (const listener of this.errorListeners) listener(error);
      }
    });
    this.socket.on('close', () => {
      for (const listener of this.closeListeners) listener();
    });
    this.socket.on('error', (error) => {
      for (const listener of this.errorListeners) listener(error);
    });
  }

  get state(): JsonRpcTransportState {
    switch (this.socket.readyState) {
      case WebSocket.CONNECTING: return 'connecting';
      case WebSocket.OPEN: return 'open';
      case WebSocket.CLOSING: return 'closing';
      default: return 'closed';
    }
  }

  send(message: JsonRpcEnvelope): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket transport 未连接');
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
  }

  terminate(): void {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.terminate();
  }

  async closeAndWait(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const timer = setTimeout(() => this.terminate(), 1000); timer.unref();
    try { this.close(); await this.physicallyClosed; } finally { clearTimeout(timer); }
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    if (this.state === 'open') queueMicrotask(listener);
    return () => this.openListeners.delete(listener);
  }

  onMessage(listener: (message: JsonRpcEnvelope) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    if (this.state === 'closed') queueMicrotask(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
}
