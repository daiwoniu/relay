import http, { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import type { RelayConfig } from '../../scripts/lib/relay-config.mjs';
import { applyTrustedForwardedHeaders } from '../../scripts/lib/frontend-access.mjs';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function connectionHeaderNames(headers: IncomingHttpHeaders): Set<string> {
  const names = new Set<string>();
  const connection = headers.connection;
  const values = Array.isArray(connection) ? connection : [connection];
  for (const value of values) {
    for (const name of String(value || '').split(',')) {
      const normalized = name.trim().toLowerCase();
      if (normalized) names.add(normalized);
    }
  }
  return names;
}

function copyHeaders(headers: IncomingHttpHeaders, websocket: boolean): http.OutgoingHttpHeaders {
  const copied: http.OutgoingHttpHeaders = {};
  const connectionNames = connectionHeaderNames(headers);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (value === undefined) continue;
    if (!websocket && (HOP_BY_HOP_HEADERS.has(normalized) || connectionNames.has(normalized))) continue;
    if (normalized === 'x-relay-token' || normalized.startsWith('x-forwarded-') || normalized === 'x-relay-client-address' || normalized === 'x-relay-frontend-version') continue;
    copied[name] = value;
  }
  return copied;
}

function copyResponseHeaders(headers: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const copied: http.OutgoingHttpHeaders = {};
  const connectionNames = connectionHeaderNames(headers);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(normalized) || connectionNames.has(normalized)) continue;
    copied[name] = value;
  }
  return copied;
}

function sendBadGateway(response: ServerResponse): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end('Relay 后端暂不可用');
}

export function createNativeReverseProxy(options: {
  target: string;
  accessToken: string;
  relayConfig: RelayConfig;
  frontendVersion?: string;
}) {
  const target = new URL(options.target);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('正式前端网关后端地址只支持 http 或 https');
  const transport = target.protocol === 'https:' ? https : http;
  const activeRequests = new Set<ClientRequest>();
  const activeSockets = new Set<Duplex>();

  function requestOptions(request: IncomingMessage, websocket: boolean): http.RequestOptions {
    return {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: request.method,
      path: request.url || '/',
      headers: copyHeaders(request.headers, websocket),
    };
  }

  function applyGatewayHeaders(proxyRequest: ClientRequest, request: IncomingMessage): void {
    proxyRequest.removeHeader('x-relay-token');
    proxyRequest.setHeader('X-Relay-Token', options.accessToken);
    applyTrustedForwardedHeaders(proxyRequest, request.headers.host, options.relayConfig, request.socket.remoteAddress, request.headers['x-forwarded-for']);
    if(options.frontendVersion)proxyRequest.setHeader('X-Relay-Frontend-Version',options.frontendVersion);
  }

  function web(request: IncomingMessage, response: ServerResponse): void {
    const proxyRequest = transport.request(requestOptions(request, false), (proxyResponse) => {
      if (response.destroyed) {
        proxyResponse.destroy();
        return;
      }
      response.writeHead(proxyResponse.statusCode || 502, proxyResponse.statusMessage, copyResponseHeaders(proxyResponse.headers));
      proxyResponse.on('error', () => response.destroy());
      proxyResponse.pipe(response);
    });
    activeRequests.add(proxyRequest);
    proxyRequest.once('close', () => activeRequests.delete(proxyRequest));
    proxyRequest.once('error', () => sendBadGateway(response));
    request.once('aborted', () => proxyRequest.destroy());
    response.once('close', () => {
      if (!response.writableEnded) proxyRequest.destroy();
    });
    applyGatewayHeaders(proxyRequest, request);
    request.pipe(proxyRequest);
  }

  function ws(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const proxyRequest = transport.request(requestOptions(request, true));
    activeRequests.add(proxyRequest);
    proxyRequest.once('close', () => activeRequests.delete(proxyRequest));
    applyGatewayHeaders(proxyRequest, request);
    proxyRequest.once('upgrade', (proxyResponse, upstreamSocket, upstreamHead) => {
      if (socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      activeSockets.add(socket);
      activeSockets.add(upstreamSocket);
      const cleanup = () => {
        activeSockets.delete(socket);
        activeSockets.delete(upstreamSocket);
        if (!socket.destroyed) socket.destroy();
        if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      };
      socket.once('error', cleanup);
      upstreamSocket.once('error', cleanup);
      socket.once('close', cleanup);
      upstreamSocket.once('close', cleanup);
      const statusLine = `HTTP/${proxyResponse.httpVersion} ${proxyResponse.statusCode || 101} ${proxyResponse.statusMessage || 'Switching Protocols'}\r\n`;
      const headers = proxyResponse.rawHeaders.reduce<string[]>((lines, value, index, raw) => {
        if (index % 2 === 0) lines.push(`${value}: ${raw[index + 1]}`);
        return lines;
      }, []);
      socket.write(`${statusLine}${headers.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });
    proxyRequest.once('response', () => socket.destroy());
    proxyRequest.once('error', () => socket.destroy());
    proxyRequest.end();
  }

  function close(): void {
    for (const request of activeRequests) request.destroy();
    for (const socket of activeSockets) socket.destroy();
    activeRequests.clear();
    activeSockets.clear();
  }

  return { web, ws, close };
}
