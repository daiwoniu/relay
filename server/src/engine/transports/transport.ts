export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcEnvelope {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export type JsonRpcTransportState = 'connecting' | 'open' | 'closing' | 'closed';

export interface JsonRpcTransport {
  readonly state: JsonRpcTransportState;
  send(message: JsonRpcEnvelope): void;
  close(): void;
  terminate(): void;
  onOpen(listener: () => void): () => void;
  onMessage(listener: (message: JsonRpcEnvelope) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}
