import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export interface OpenCodeInstallation {
  version: string | null;
  installSource: 'official_npm_global' | 'unknown';
  executable: string | null;
}

export function inspectOpenCodeInstallation(options: {
  platform?: NodeJS.Platform;
  envPath?: string;
  exists?: (candidate: string) => boolean;
  readFile?: (candidate: string) => string;
} = {}): OpenCodeInstallation {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const separator = platform === 'win32' ? ';' : path.delimiter;
  const exists = options.exists ?? fs.existsSync;
  const readFile = options.readFile ?? ((candidate) => fs.readFileSync(candidate, 'utf8'));
  for (const directory of (options.envPath ?? process.env.PATH ?? '').split(separator).filter(Boolean)) {
    const packageRoot = pathApi.join(directory, 'node_modules', 'opencode-ai');
    const packageFile = pathApi.join(packageRoot, 'package.json');
    const executable = pathApi.join(packageRoot, 'bin', platform === 'win32' ? 'opencode.exe' : 'opencode');
    if (!exists(packageFile) || !exists(executable)) continue;
    try {
      const version = JSON.parse(readFile(packageFile)).version;
      if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
        return { version, installSource: 'official_npm_global', executable };
      }
    } catch {}
    return { version: null, installSource: 'unknown', executable };
  }
  return { version: null, installSource: 'unknown', executable: null };
}
