import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { findListeningPids, isCodexGhostListener } from './service-control.mjs';
export { isCodexGhostListener } from './service-control.mjs';

const statePath = (root) => path.join(root, '.relay-dev', 'codex-runtime-endpoint.json');
const baseKey = (config) => `${config.codex.host}:${config.codex.port}`;

function withPort(config, port) {
  const authority = `${net.isIP(config.codex.host) === 6 ? `[${config.codex.host}]` : config.codex.host}:${port}`;
  return { ...config, codex: { ...config.codex, port, authority, wsUrl: `ws://${authority}`, readyUrl: `http://${authority}/readyz` } };
}

/** Local runtime selection, never rewrite the user's relay.conf. Check/stop read the same selection. */
export function readCodexRuntimeConfig(root, config) {
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return config; throw new Error('Codex 运行端口记录无法读取，请检查 .relay-dev/codex-runtime-endpoint.json', { cause: error }); }
  if (state?.version !== 1 || state.configured !== baseKey(config)) return config;
  if (!Number.isInteger(state.port) || state.port < 1024 || state.port > 65535
    || [config.backend.port, config.frontend.port].includes(state.port)) throw new Error('Codex 运行端口记录无效');
  return withPort(config, state.port);
}

/** A failed TCP connection does not establish that a port can be rebound. */
export function canBindEndpoint({ host, port }, { createServer = net.createServer } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    // Windows excluded/reserved ports can report EACCES without a netstat owner.
    server.once('error', (error) => ['EADDRINUSE', 'EACCES'].includes(error.code) ? resolve(false) : reject(error));
    server.listen({ host, port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve(true)));
  });
}

export async function recoverCodexRuntimeConfig(root, configured, options = {}) {
  if (options.enabled === false) return configured;
  const current = readCodexRuntimeConfig(root, configured);
  if ((options.platform ?? process.platform) !== 'win32') return current;
  const scan = options.findListeningPidsFn ?? findListeningPids;
  const ghost = () => isCodexGhostListener({ id: 'codex' }, scan([current.codex.port]).get(current.codex.port) ?? [], options);
  if (!ghost()) return current; // Never bypass a live or inaccessible owner.
  await (options.delay ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms))))(150);
  if (!ghost()) return current; // Exclude transient PID/port races.
  const candidates = Array.from({ length: 32 }, (_, index) => 1024 + ((Math.max(configured.codex.port, 1024) - 1024 + index + 1) % (65536 - 1024)))
    .filter(port => ![current.codex.port, configured.backend.port, configured.frontend.port].includes(port));
  const listeners = scan(candidates);
  for (const port of candidates) {
    if ((listeners.get(port) ?? []).length || !await (options.canBindFn ?? canBindEndpoint)({ host: current.codex.host, port })) continue;
    const file = statePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, configured: baseKey(configured), port }) + '\n', { flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    options.write?.(`Codex 旧端口 ${current.codex.port} 残留已退出 PID 的监听，改用本机端口 ${port}；无需重启 Windows，原配置未修改。`);
    return withPort(configured, port);
  }
  throw new Error('Codex 旧端口异常残留，附近 32 个候选端口均不可用；请为 CODEX_PORT 配置一个空闲端口，无需重启 Windows');
}

/** Used by both restart paths. A Codex ghost may be bypassed by the next runner. */
export async function relayTargetReleased(target, codexPort, options = {}) {
  const pids = (options.findListeningPidsFn ?? findListeningPids)([target.port]).get(target.port) ?? [];
  if (isCodexGhostListener({ id: target.port === codexPort ? 'codex' : 'other' }, pids, options)) return true;
  if (pids.length) return false;
  return (options.canBindFn ?? canBindEndpoint)(target);
}
