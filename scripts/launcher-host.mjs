import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createLauncherHost,
  waitForRelayPortsReleased,
} from './lib/launcher-host.mjs';
import {
  getRelayServiceTargets,
  loadRelayConfig,
} from './lib/relay-config.mjs';
import { installTerminalTimestamps } from './lib/terminal-timestamps.mjs';
import { readCodexRuntimeConfig, relayTargetReleased } from './lib/codex-port-recovery.mjs';

installTerminalTimestamps();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const helpRequested = args.includes('help') || args.includes('--help');
let waitForPortsReleased;
if (!helpRequested) {
  try {
    const configured = loadRelayConfig(path.join(root, 'config', 'relay.conf'));
    waitForPortsReleased = () => {
      const config = readCodexRuntimeConfig(root, configured);
      return waitForRelayPortsReleased({ targets: getRelayServiceTargets(config),
        isTargetReleased: target => relayTargetReleased(target, config.codex.port) });
    };
  } catch (error) {
    console.error(`Relay 配置加载失败：${error.message}`);
    process.exit(1);
  }
}
const host = createLauncherHost({
  root,
  args,
  ...(waitForPortsReleased ? { waitForPortsReleased } : {}),
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(signal, () => host.stop(signal)); } catch {}
}
host.launch();
