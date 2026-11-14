import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { collectInventory } from './lib/storage-inventory.mjs';

export function hasWalResetFix(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 3 || major === 3 && (minor > 51 || minor === 51 && patch >= 3
    || minor === 50 && patch >= 7 || minor === 44 && patch >= 6);
}

export function parseOptions(args) {
  const options = { sizeMiB: 1, iterations: 30, legacySamples: 1 };
  const keys = { '--size-mib': ['sizeMiB', 1, 330], '--iterations': ['iterations', 5, 100], '--legacy-samples': ['legacySamples', 0, 3] };
  for (let i = 0; i < args.length; i += 2) {
    const entry = keys[args[i]];
    const value = Number(args[i + 1]);
    if (!entry || !/^\d+$/.test(args[i + 1] ?? '') || value < entry[1] || value > entry[2]) throw Error('Invalid probe arguments');
    options[entry[0]] = value;
  }
  return options;
}

export async function runProbe(options) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const scratchRoot = path.join(root, '.relay-dev', 'storage-baseline');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'tmp-'));
  const environment = { logicalCpus: os.availableParallelism(), cpu: os.cpus()[0]?.model,
    totalMemoryMiB: Math.round(os.totalmem() / 1024 ** 2),
    freeMemoryBeforeMiB: Math.round(os.freemem() / 1024 ** 2), scratchVolume: path.parse(directory).root };
  let worker;
  let timer;
  try {
    const ticks = [];
    let pauseStart;
    worker = new Worker(new URL('./lib/storage-probe-worker.mjs', import.meta.url), { workerData: { ...options, directory } });
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(Error('Isolated probe timed out')); void worker.terminate();
      }, 60_000);
      timer = setInterval(() => { if (pauseStart !== undefined) ticks.push(performance.now() - pauseStart); }, 20);
      let record;
      worker.on('message', (message) => {
        if (message.type === 'pause') pauseStart = performance.now();
        if (message.type === 'result') record = message.result;
        if (message.type === 'failed') record = { failed: `${message.phase}:${message.code}` };
      });
      worker.once('error', () => { clearTimeout(timeout); reject(Error('Isolated worker failed')); });
      worker.once('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0 || !record || record.failed) reject(Error(`Isolated probe failed (${record?.failed ?? code})`));
        else resolve(record);
      });
    });
    return { ...result, environment, walResetFix: hasWalResetFix(result.sqliteVersion),
      isolation: { timerTicksDuringWorkerPause: ticks.filter((ms) => ms < result.workerPauseMs).length },
      limitations: ['Synthetic single-worker baseline; not a production workload SLA.',
        'WAL bytes and exported bytes are application-level amounts, not physical device writes.',
        'No production database, server, credentials, network or engine is accessed.',
        'Only current host/Node version tested; other OS/architectures remain unverified.'] };
  } finally {
    clearInterval(timer);
    await worker?.terminate();
    // Only the private mkdtemp directory owned by this invocation is removed.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('node server/scripts/storage-probe.mjs [--size-mib 1..330] [--iterations 5..100] [--legacy-samples 0..3]\nCreates only synthetic temporary DBs; writes sanitized report/inventory under .relay-dev/storage-baseline/.');
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await runProbe(options);
  const inventory = collectInventory(root);
  const outputRoot = path.join(root, '.relay-dev', 'storage-baseline');
  fs.mkdirSync(outputRoot, { recursive: true });
  const output = fs.mkdtempSync(path.join(outputRoot, 'run-'));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));
  fs.writeFileSync(path.join(output, 'inventory.json'), JSON.stringify(inventory, null, 2));
  console.log(JSON.stringify({ report: path.relative(root, output).split(path.sep).join('/'),
    node: result.node, sqlite: result.sqliteVersion, walResetFix: result.walResetFix,
    checks: result.checks, sqliteBaseline: result.sqlite, legacyBaseline: result.legacy,
    isolation: result.isolation, inventoryFiles: inventory.entries.length }, null, 2));
  if (!result.walResetFix || result.isolation.timerTicksDuringWorkerPause < 3) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
