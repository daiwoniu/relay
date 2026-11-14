interface DisposableWebSocket {
  readyState: number;
  onopen: WebSocket['onopen'];
  onmessage: WebSocket['onmessage'];
  onclose: WebSocket['onclose'];
  onerror: WebSocket['onerror'];
  close: () => void;
}

export type WebSocketDisposeResult = 'closed' | 'deferred' | 'noop';

export function disposeWebSocket(ws: DisposableWebSocket): WebSocketDisposeResult {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  if (ws.readyState === 1) {
    ws.close();
    return 'closed';
  }
  if (ws.readyState === 0) {
    ws.onopen = () => ws.close();
    return 'deferred';
  }
  return 'noop';
}
