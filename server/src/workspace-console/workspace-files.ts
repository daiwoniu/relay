import fs from 'node:fs/promises';
import { requireWorkspaceFile, requireWorkspaceDirectory } from './workspace-config.js';
import path from 'node:path';

/** All adapter file reads are bounded and stay beneath the configured business root. */
export async function readWorkspaceFile(root: string, filename: string, maxBytes = 1024 * 1024): Promise<string> {
  const checked = requireWorkspaceFile(root, path.relative(root, filename));
  const handle = await fs.open(checked, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('工作台来源文件超过大小限制或类型无效');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes || bytesRead > stat.size) throw new Error('工作台来源文件超过大小限制或读取期间发生变化');
    return buffer.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, '');
  } finally { await handle.close(); }
}
export async function readWorkspaceDirectory(root: string, directory: string) {
  const checked = requireWorkspaceDirectory(root, path.relative(root, directory));
  const entries = await fs.readdir(checked, { withFileTypes: true });
  if (entries.length > 10000) throw new Error('工作台目录条目超过安全上限');
  return entries;
}
