import fs from 'node:fs';
import path from 'node:path';
import type { NewsItemInput } from '../types.js';
import { monthKey, shardPath } from '../storage/news-shards.js';

const MIB = 1024 * 1024;

export function capacityDecision(freeBytes: number, largestShardBytes: number): { allowed: boolean; requiredBytes: number } {
  const requiredBytes = Math.max(256 * MIB, largestShardBytes * 2);
  return { allowed: freeBytes >= requiredBytes, requiredBytes };
}

export function inspectCapacity(dataDir: string, items: NewsItemInput[]): { allowed: boolean; requiredBytes: number; freeBytes: number | null } {
  const target = fs.existsSync(dataDir) ? dataDir : path.dirname(dataDir);
  let largestShardBytes = 0;
  for (const month of new Set(items.map((item) => monthKey(item.publishedAt)))) {
    const filename = shardPath(dataDir, month);
    if (fs.existsSync(filename)) largestShardBytes = Math.max(largestShardBytes, fs.statSync(filename).size);
  }
  try {
    const stats = fs.statfsSync(target);
    const freeBytes = stats.bavail * stats.bsize;
    return { ...capacityDecision(freeBytes, largestShardBytes), freeBytes };
  } catch {
    // 不支持 statfs 的文件系统仍由原子写盘失败保护；状态中注明无法测得剩余空间。
    return { allowed: true, requiredBytes: capacityDecision(Infinity, largestShardBytes).requiredBytes, freeBytes: null };
  }
}
