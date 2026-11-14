import type { JsonRpcEnvelope } from './transport.js';

export type NdjsonParserErrorCode = 'INVALID_JSON' | 'INVALID_ENVELOPE';

export class NdjsonParserError extends Error {
  constructor(
    readonly code: NdjsonParserErrorCode,
    readonly preview: string,
  ) {
    super(code === 'INVALID_JSON' ? 'ACP stdout 包含非法 JSON' : 'ACP stdout 包含非 JSON-RPC 信封');
    this.name = 'NdjsonParserError';
  }
}

export interface NdjsonParserOptions {
  onMessage(message: JsonRpcEnvelope): void;
  onError(error: NdjsonParserError): void;
}

const MAX_BUFFER_LENGTH = 8 * 1024 * 1024;

function isJsonRpcEnvelope(value: unknown): value is JsonRpcEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.jsonrpc !== undefined && envelope.jsonrpc !== '2.0') return false;
  const hasMethod = typeof envelope.method === 'string' && envelope.method.length > 0;
  const hasId = typeof envelope.id === 'string' || typeof envelope.id === 'number';
  if (hasMethod) return envelope.id === undefined || hasId;
  return hasId && ('result' in envelope || 'error' in envelope);
}

export class NdjsonParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private ended = false;

  constructor(private readonly options: NdjsonParserOptions) {}

  push(chunk: string | Uint8Array): void {
    if (this.ended) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.buffer.length > MAX_BUFFER_LENGTH && !this.buffer.includes('\n')) {
      const preview = this.buffer.trim().slice(0, 120);
      this.buffer = '';
      this.options.onError(new NdjsonParserError('INVALID_JSON', preview));
      return;
    }
    this.drainLines();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.buffer += this.decoder.decode();
    const tail = this.buffer;
    this.buffer = '';
    if (tail.trim()) this.parseLine(tail.replace(/\r$/, ''));
  }

  private drainLines(): void {
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    const preview = line.trim().slice(0, 120);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.onError(new NdjsonParserError('INVALID_JSON', preview));
      return;
    }
    if (!isJsonRpcEnvelope(parsed)) {
      this.options.onError(new NdjsonParserError('INVALID_ENVELOPE', preview));
      return;
    }
    this.options.onMessage(parsed);
  }
}
