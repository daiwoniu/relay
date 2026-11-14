import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launcherRunnerArguments, parseLauncherRestartArguments, waitForLauncherExitAndPorts, waitForLauncherRestartBegin } from './lib/launcher-restart.mjs';
import { getRelayServiceTargets, loadRelayConfig } from './lib/relay-config.mjs';
import { readCodexRuntimeConfig, relayTargetReleased } from './lib/codex-port-recovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseLauncherRestartArguments(process.argv.slice(2));
if (!options) process.exit(2);
let targets;
let runtimeConfig;
try {
  runtimeConfig = readCodexRuntimeConfig(root, loadRelayConfig(path.join(root, 'config', 'relay.conf')));
  targets = getRelayServiceTargets(runtimeConfig);
} catch {
  process.exit(5);
}

if (typeof process.send !== 'function') process.exit(4);
process.send({ channel: 'relay-launcher-restart-v1', type: 'ready' });
if (!await waitForLauncherRestartBegin(process)) process.exit(0);

const processAlive = async (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const targetListening = async (target) => !await relayTargetReleased(target, runtimeConfig.codex.port);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!await waitForLauncherExitAndPorts({
  parentPid: options.parentPid,
  targets,
  processAlive,
  targetListening,
  delay,
})) process.exit(3);
const args = launcherRunnerArguments({ root, ...options });
const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'ignore', detached: true, windowsHide: true });
child.unref();
