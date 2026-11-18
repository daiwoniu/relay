import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyShareDocumentHeaders,
  isAllowedFrontendHost,
} from '../../scripts/lib/frontend-access.mjs';
import { loadRelayConfig, type RelayConfig } from '../../scripts/lib/relay-config.mjs';
import { loadFrontendGatewayToken } from './frontend-gateway-token.js';
import { createNativeReverseProxy } from './native-reverse-proxy.js';
import { readFrontendVersion } from '../../scripts/lib/frontend-version.mjs';
import { handleFrontendIpDiagnostic, IP_DIAGNOSTIC_PATH } from './frontend-ip-diagnostic.js';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const BUILD_ID_PATTERN = /^[a-f0-9]{8,16}$/;

function sendText(response: ServerResponse, status: number, text: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(text);
}

function resolveStaticPath(releaseRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const candidate = path.resolve(releaseRoot, `.${decoded}`);
  return candidate === releaseRoot || candidate.startsWith(`${releaseRoot}${path.sep}`) ? candidate : null;
}

function serveFile(request: IncomingMessage, response: ServerResponse, filePath: string, cacheControl: string): void {
  const stat = fs.statSync(filePath);
  response.statusCode = 200;
  response.setHeader('Content-Type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  response.setHeader('Content-Length', String(stat.size));
  response.setHeader('Cache-Control', cacheControl);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(filePath).pipe(response);
}

export function createFrontendGateway(options: {
  releaseDir: string;
  buildId: string;
  buildLabel?: string;
  accessToken: string;
  backendTarget?: string;
  relayConfig: RelayConfig;
  startedAt?: number;
  diagnosticWindowFile?: string;
}) {
  const releaseRoot = path.resolve(options.releaseDir);
  const indexPath = path.join(releaseRoot, 'index.html');
  if (!BUILD_ID_PATTERN.test(options.buildId)) throw new Error('正式前端网关 buildId 无效');
  if (!options.accessToken.trim()) throw new Error('正式前端网关缺少内部访问令牌');
  if (!fs.existsSync(releaseRoot) || !fs.statSync(releaseRoot).isDirectory()) throw new Error('正式前端 release 不存在');
  if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) throw new Error('正式前端 release 缺少 index.html');
  const frontendVersion=readFrontendVersion(releaseRoot);

  const backendTarget = options.backendTarget || options.relayConfig.backend.origin;
  const startedAt = options.startedAt ?? Date.now();
  const proxy = createNativeReverseProxy({
    target: backendTarget,
    accessToken: options.accessToken,
    relayConfig: options.relayConfig,
    frontendVersion,
  });

  const server = http.createServer((request, response) => {
    if (!isAllowedFrontendHost(request.headers.host, options.relayConfig)) {
      sendText(response, 403, 'Relay 拒绝了未配置的访问地址');
      return;
    }
    const url = new URL(request.url || '/', 'http://relay.local');
    if (url.pathname === IP_DIAGNOSTIC_PATH) {
      void handleFrontendIpDiagnostic(request, response, {
        windowFile: options.diagnosticWindowFile, backendTarget,
        accessToken: options.accessToken, relayConfig: options.relayConfig,
      }).catch(() => { if (!response.writableEnded) sendText(response, 503, '诊断暂不可用'); });
      return;
    }
    if (url.pathname === '/__relay/frontend-status') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify({ startedAt, mode: 'production', buildId: options.buildId, buildLabel: options.buildLabel || null }));
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/') || /^\/p(?:-preview)?(?:\/|$)/.test(url.pathname)) {
      proxy.web(request, response);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      sendText(response, 405, 'Method Not Allowed');
      return;
    }
    applyShareDocumentHeaders(request, response);
    const requestedPath = resolveStaticPath(releaseRoot, url.pathname);
    if (!requestedPath) {
      sendText(response, 400, '无效的静态资源路径');
      return;
    }
    if (url.pathname.startsWith('/assets/') && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
      serveFile(request, response, requestedPath, 'public, max-age=31536000, immutable');
      return;
    }
    if (fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile() && requestedPath !== indexPath) {
      serveFile(request, response, requestedPath, 'no-store');
      return;
    }
    serveFile(request, response, indexPath, 'no-store');
  });

  server.on('upgrade', (request, socket, head) => {
    if (!isAllowedFrontendHost(request.headers.host, options.relayConfig)) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url || '/', 'http://relay.local');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    proxy.ws(request, socket, head);
  });
  server.on('close', () => proxy.close());
  return server;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const root = path.resolve(path.dirname(currentFile), '../..');
  const relayConfig = loadRelayConfig(path.join(root, 'config', 'relay.conf'));
  const accessToken = loadFrontendGatewayToken({
    configuredToken: process.env.RELAY_ACCESS_TOKEN,
    tokenFile: process.env.RELAY_TOKEN_FILE || path.join(root, 'server', 'data', 'access-token'),
  });
  const releaseDir = process.env.RELAY_FRONTEND_RELEASE_DIR;
  const buildId = process.env.RELAY_FRONTEND_BUILD_ID;
  if (!releaseDir || !buildId) throw new Error('正式前端网关缺少 release 路径或 buildId');
  const server = createFrontendGateway({
    releaseDir,
    buildId,
    buildLabel: process.env.RELAY_FRONTEND_BUILD_LABEL,
    accessToken,
    backendTarget: relayConfig.backend.origin,
    relayConfig,
    diagnosticWindowFile: path.join(root, '.relay-dev', 'source-ip-diagnostic.json'),
  });
  const host = relayConfig.frontend.listenHost;
  const port = relayConfig.frontend.port;
  server.listen(port, host, () => {
    const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    console.log(`[Relay] 正式前端网关已启动 → http://${authority}`);
  });
}
