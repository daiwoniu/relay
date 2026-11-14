import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const DEFAULT_BUILD_BUDGET = Object.freeze({
  maxChunkBytes: 500 * 1024,
  // 2026-11-14 经用户确认，连续彩色动效预算为 1.74 MiB / 544 KiB。
  maxTotalBytes: 1.74 * 1024 * 1024,
  maxGzipTotalBytes: 544 * 1024,
  maxOfflineScriptBytes: 4 * 1024,
});

export function evaluateBuildBudget(chunks, offlineScriptBytes, budget = DEFAULT_BUILD_BUDGET) {
  const sorted = [...chunks].sort((left, right) => right.bytes - left.bytes);
  const totalBytes = sorted.reduce((sum, chunk) => sum + chunk.bytes, 0);
  const gzipTotalBytes = sorted.reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
  const oversizedChunks = sorted.filter((chunk) => chunk.bytes > budget.maxChunkBytes);
  const totalExceeded = totalBytes > budget.maxTotalBytes;
  const gzipTotalExceeded = gzipTotalBytes > budget.maxGzipTotalBytes;
  const offlineScriptExceeded = offlineScriptBytes > budget.maxOfflineScriptBytes;
  return {
    chunks: sorted,
    totalBytes,
    gzipTotalBytes,
    offlineScriptBytes,
    oversizedChunks,
    totalExceeded,
    gzipTotalExceeded,
    offlineScriptExceeded,
    ok: oversizedChunks.length === 0 && !totalExceeded && !gzipTotalExceeded && !offlineScriptExceeded,
  };
}

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function run() {
  const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(clientRoot, 'dist');
  const assetsDir = path.join(distDir, 'assets');
  const chunks = fs.readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => {
      const content = fs.readFileSync(path.join(assetsDir, name));
      return { name, bytes: content.length, gzipBytes: gzipSync(content, { level: 9 }).length };
    });
  const offlineScriptPath = path.join(distDir, 'static-share-script.js');
  if (!fs.existsSync(offlineScriptPath)) throw new Error(`缺少离线分享脚本：${offlineScriptPath}`);
  const offlineScriptBytes = fs.statSync(offlineScriptPath).size;
  const result = evaluateBuildBudget(chunks, offlineScriptBytes);

  console.log(`JavaScript 构建预算：最大 chunk ${formatKiB(DEFAULT_BUILD_BUDGET.maxChunkBytes)}，总量 ${formatKiB(DEFAULT_BUILD_BUDGET.maxTotalBytes)}`);
  console.log(`传输与离线脚本预算：gzip 总量 ${formatKiB(DEFAULT_BUILD_BUDGET.maxGzipTotalBytes)}，离线脚本 ${formatKiB(DEFAULT_BUILD_BUDGET.maxOfflineScriptBytes)}`);
  for (const chunk of result.chunks) console.log(`- ${chunk.name}: ${formatKiB(chunk.bytes)}（gzip ${formatKiB(chunk.gzipBytes)}）`);
  console.log(`- 总量: ${formatKiB(result.totalBytes)}`);
  console.log(`- gzip 总量: ${formatKiB(result.gzipTotalBytes)}`);
  console.log(`- 离线脚本: ${formatKiB(result.offlineScriptBytes)}`);

  if (!result.ok) {
    if (result.oversizedChunks.length > 0) console.error(`超出单 chunk 预算：${result.oversizedChunks.map((chunk) => chunk.name).join('、')}`);
    if (result.totalExceeded) console.error('超出 JavaScript 总量预算');
    if (result.gzipTotalExceeded) console.error('超出 JavaScript gzip 总量预算');
    if (result.offlineScriptExceeded) console.error('超出离线分享脚本预算');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
