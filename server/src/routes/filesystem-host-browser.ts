import { spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { TextDecoder } from 'node:util';

const WINDOWS_METADATA_COMMAND_TIMEOUT_MS = 10_000;

export interface DirEntry {
  name: string;
  path: string;
  modifiedAt: number | null;
}

export interface HostFileEntry extends DirEntry {
  kind: 'directory' | 'file';
  size: number | null;
  modifiedAt: number | null;
}

/** 列出目录下的子目录 */
export function listDirs(dirPath: string): DirEntry[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .flatMap((entry): DirEntry[] => {
      const entryPath = path.join(dirPath, entry.name);
      try {
        return [{ name: entry.name, path: entryPath, modifiedAt: fs.statSync(entryPath).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function windowsEntryNameKey(name: string): string {
  return name.toLowerCase();
}

let windowsConsoleEncoding: string | null | undefined;

function getWindowsConsoleEncoding(): string | null {
  if (windowsConsoleEncoding !== undefined) return windowsConsoleEncoding;
  const result = spawnSync('cmd.exe', ['/d', '/c', 'chcp'], {
    encoding: 'ascii',
    timeout: WINDOWS_METADATA_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  const codePage = result.stdout.match(/(\d+)\s*$/)?.[1] || '';
  const encodings: Record<string, string> = {
    '65001': 'utf-8',
    '936': 'gbk',
    '950': 'big5',
    '932': 'shift_jis',
    '949': 'euc-kr',
    '1250': 'windows-1250',
    '1251': 'windows-1251',
    '1252': 'windows-1252',
    '1253': 'windows-1253',
    '1254': 'windows-1254',
    '1255': 'windows-1255',
    '1256': 'windows-1256',
    '1257': 'windows-1257',
    '1258': 'windows-1258',
  };
  windowsConsoleEncoding = encodings[codePage] || null;
  return windowsConsoleEncoding;
}

export function parseWindowsHiddenAttribOutput(output: string): Set<string> {
  const hiddenNames = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const pathIndex = line.search(/[A-Za-z]:\\|\\\\/);
    if (pathIndex < 0 || !line.slice(0, pathIndex).includes('H')) continue;
    const entryPath = line.slice(pathIndex).trim();
    if (entryPath) hiddenNames.add(windowsEntryNameKey(path.basename(entryPath)));
  }
  return hiddenNames;
}

export function assertWindowsHiddenAttribSucceeded(result: {
  status: number | null;
  error?: NodeJS.ErrnoException;
}): void {
  if (result.error?.code === 'ETIMEDOUT') throw new Error('读取 Windows 文件隐藏属性超时');
  if (result.status !== 0 || result.error) throw new Error('无法读取 Windows 文件隐藏属性');
}

export function getWindowsHiddenEntryNames(dirPath: string): Set<string> {
  if (process.platform !== 'win32') return new Set();
  const result = spawnSync('attrib.exe', [path.join(dirPath, '*'), '/D'], {
    timeout: WINDOWS_METADATA_COMMAND_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  assertWindowsHiddenAttribSucceeded(result);
  const encoding = getWindowsConsoleEncoding();
  if (!encoding) throw new Error('当前 Windows 控制台编码不受支持，无法安全过滤隐藏文件');
  const output = new TextDecoder(encoding).decode(result.stdout);
  return parseWindowsHiddenAttribOutput(output);
}

export function listHostFileEntries(
  dirPath: string,
  hiddenEntryNames?: Set<string>,
): HostFileEntry[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const resolvedHiddenEntryNames = hiddenEntryNames
    ?? (entries.length > 0 ? getWindowsHiddenEntryNames(dirPath) : new Set<string>());
  const hiddenNames = new Set([...resolvedHiddenEntryNames].map(windowsEntryNameKey));
  return entries.flatMap((entry): HostFileEntry[] => {
    if (entry.name.startsWith('.') || hiddenNames.has(windowsEntryNameKey(entry.name))) return [];
    const entryPath = path.join(dirPath, entry.name);
    try {
      const realPath = fs.realpathSync(entryPath);
      const stat = fs.statSync(realPath);
      if (stat.isDirectory()) return [{ name: entry.name, path: realPath, kind: 'directory', size: null, modifiedAt: stat.mtimeMs }];
      if (stat.isFile()) return [{ name: entry.name, path: realPath, kind: 'file', size: stat.size, modifiedAt: stat.mtimeMs }];
      return [];
    } catch {
      return [];
    }
  }).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 获取 Windows 盘符列表 */
export function getWindowsDrives(): string[] {
  const drives: string[] = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const drivePath = `${letter}:\\`;
    try {
      fs.accessSync(drivePath, fs.constants.F_OK);
      drives.push(`${letter}:`);
    } catch {
      // 盘符不存在
    }
  }
  return drives;
}
