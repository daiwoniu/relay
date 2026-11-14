import { createServer } from 'node:net';

/** Older sql.js backends do not honor the new DB owner. Refuse migration while their endpoint is occupied. */
export async function assertBackendStopped(host: string, port: number) {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen({ host, port, exclusive: true }, resolve);
    });
  } catch { throw Error('BACKEND_STOP_REQUIRED'); }
  finally {
    if (probe.listening) await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  }
}
