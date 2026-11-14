import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { extractAccessToken, isAllowedOrigin, isValidAccessToken } from './security.js';

interface ManagedApplication {
  app: Hono<any>;
  readonly status: string;
  activate: () => Promise<unknown>;
  attachFrontend: (server: WebSocketServer) => unknown;
  close: () => Promise<void>;
}

/** Listener ownership is explicit; startup failures join application shutdown and never start a legacy fallback. */
export async function listenStoredManagedApplication(application: ManagedApplication, endpoint: { hostname: string; port: number }) {
  if (!endpoint.hostname || !Number.isSafeInteger(endpoint.port) || endpoint.port < 0 || endpoint.port > 65535) throw Error('MANAGED_LISTENER_INVALID_ENDPOINT');
  let accepting = true;
  const server = createAdaptorServer({ fetch: (request, env) => accepting ? application.app.fetch(request, env)
    : new Response('Service unavailable', { status: 503 }) }) as Server;
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024, verifyClient: (info, done) => {
    if (!accepting || application.status !== 'ready') return done(false, 503, 'Service recovering');
    if (!isAllowedOrigin(info.origin || info.req.headers.origin)) return done(false, 403, 'Origin not allowed');
    const header = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
    let token: string | null;
    try { token = extractAccessToken(header(info.req.headers.authorization), header(info.req.headers['x-relay-token']), new URL(info.req.url || '/', 'http://localhost').searchParams.get('token')); }
    catch { return done(false, 400, 'Invalid request'); }
    if (!isValidAccessToken(token)) return done(false, 401, 'Unauthorized');
    // Native cookie authentication, forced-password policy and current membership are checked by the attached frontend before any data is sent.
    done(true);
  } });
  let closing: Promise<void> | undefined, transportClose: Promise<void> | undefined, started = false;
  const close = () => {
    if (closing) return closing;
    accepting = false;
    transportClose ??= (async () => {
      for (const client of wss.clients) client.terminate();
      await Promise.all([
        new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => { if (!server.listening) return resolve(); server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }),
      ]);
    })();
    const run = Promise.all([application.close(), transportClose]).then(() => undefined);
    closing = run; void run.catch(() => { if (closing === run) closing = undefined; }); return run;
  };
  const transportError = () => { if (started) void close().catch(() => { console.error('[Relay] MANAGED_LISTENER_CLEANUP_UNCONFIRMED'); }); };
  // ws forwards HTTP server errors; listening errors are handled by the startup promise below.
  wss.on('error', transportError); server.on('error', transportError);
  try {
    application.attachFrontend(wss);
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => { server.off('listening', listening); reject(cause); };
      const listening = () => { server.off('error', error); resolve(); };
      server.once('error', error); server.once('listening', listening); server.listen(endpoint.port, endpoint.hostname);
    });
    await application.activate();
    started = true;
    return { server, address: server.address(), close };
  } catch (cause) {
    try { await close(); } catch { throw new AggregateError([cause], 'MANAGED_LISTENER_CLEANUP_UNCONFIRMED'); }
    throw cause;
  }
}
