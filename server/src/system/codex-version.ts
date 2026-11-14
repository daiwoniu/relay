import { execFileSync } from 'node:child_process';
import type { CodexVersionDto } from '../contracts/index.js';
import { extractReleaseOverview } from './release-summary.js';

const CODEX_LATEST_URL = 'https://registry.npmjs.org/@openai%2Fcodex/latest';
const VERSION_CHECK_TIMEOUT_MS = 5_000;
const CODEX_RELEASE_URL_PREFIX = 'https://api.github.com/repos/openai/codex/releases/tags/rust-v';
const CODEX_RELEASE_PAGE_PREFIX = 'https://github.com/openai/codex/releases/tag/rust-v';

interface CodexVersionDependencies {
  readCurrentVersion: () => string;
  fetchLatestVersion: () => Promise<string>;
  fetchLatestPublishedAt?: (version: string) => Promise<number | null>;
  fetchRelease?: (version: string) => Promise<CodexReleaseMetadata>;
  now: () => number;
}

interface ParsedVersion {
  core: number[];
  prerelease: string[];
}

interface CodexReleaseMetadata {
  body: string;
  publishedAt: number | null;
}

function parseReleasePublishedAt(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') || [],
  };
}

export function extractCodexVersion(value: unknown): string | null {
  const match = /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z.-])/.exec(String(value || '').trim());
  return match?.[1] || null;
}

export function compareCodexVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function getCodexReleasePageUrl(version: string): string {
  return `${CODEX_RELEASE_PAGE_PREFIX}${encodeURIComponent(version)}`;
}

export function getCodexVersionCommand(
  platform = process.platform,
  comSpec = process.env.ComSpec,
): { file: string; args: string[] } {
  return platform === 'win32'
    ? {
        file: comSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'codex.cmd --version'],
      }
    : { file: 'codex', args: ['--version'] };
}

function readInstalledCodexVersion(): string {
  const command = getCodexVersionCommand();
  return execFileSync(command.file, command.args, {
    encoding: 'utf8',
    timeout: VERSION_CHECK_TIMEOUT_MS,
    windowsHide: true,
  });
}

export async function fetchLatestCodexNpmVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(CODEX_LATEST_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'relay',
    },
    signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Codex npm latest check failed: ${response.status}`);
  const payload = await response.json() as { version?: unknown };
  if (typeof payload.version !== 'string') throw new Error('Codex npm latest response missing version');
  return payload.version;
}

export async function fetchCodexRelease(version: string, fetchImpl: typeof fetch = fetch): Promise<CodexReleaseMetadata> {
  if (!parseVersion(version)) throw new Error('invalid Codex release version');
  const response = await fetchImpl(`${CODEX_RELEASE_URL_PREFIX}${encodeURIComponent(version)}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'relay' },
    signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Codex release notes check failed: ${response.status}`);
  const payload = await response.json() as { body?: unknown; published_at?: unknown };
  return {
    body: typeof payload.body === 'string' ? payload.body : '',
    publishedAt: parseReleasePublishedAt(payload.published_at),
  };
}

export function createCodexVersionService(dependencies: CodexVersionDependencies) {
  let initialized = false;
  let activeCheck: Promise<CodexVersionDto> | null = null;
  let state: CodexVersionDto = {
    currentVersion: null,
    latestVersion: null,
    releaseOverview: null,
    releasePublishedAt: null,
    updateAvailable: null,
    status: 'error',
    checkedAt: null,
  };

  const getSnapshot = (): CodexVersionDto => ({ ...state });

  const refreshCurrentVersion = (): void => {
    try {
      const currentVersion = extractCodexVersion(dependencies.readCurrentVersion());
      state = {
        ...state,
        currentVersion,
        updateAvailable: currentVersion && state.latestVersion
          ? compareCodexVersions(state.latestVersion, currentVersion) > 0
          : null,
      };
    } catch {
      state = { ...state, currentVersion: null, updateAvailable: null };
    }
  };

  const checkLatest = (): Promise<CodexVersionDto> => {
    if (activeCheck) return activeCheck;
    if (state.status !== 'checking') refreshCurrentVersion();
    state = { ...state, status: 'checking' };
    activeCheck = (async () => {
      try {
        const latestVersion = extractCodexVersion(await dependencies.fetchLatestVersion());
        if (!latestVersion) throw new Error('无法解析 Codex 最新版本');
        const updateAvailable = state.currentVersion
          ? compareCodexVersions(latestVersion, state.currentVersion) > 0
          : null;
        let releaseOverview: CodexVersionDto['releaseOverview'] = updateAvailable
          ? {
              sourceStatus: 'unavailable',
              counts: { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 },
              topics: [],
              officialSource: 'codex_github',
              officialUrl: getCodexReleasePageUrl(latestVersion),
            }
          : null;
        let releasePublishedAt: number | null = null;
        if (dependencies.fetchLatestPublishedAt) {
          try { releasePublishedAt = await dependencies.fetchLatestPublishedAt(latestVersion); } catch {}
        }
        if (updateAvailable && dependencies.fetchRelease) {
          try {
            const release = await dependencies.fetchRelease(latestVersion);
            releaseOverview = {
              ...extractReleaseOverview(release.body),
              officialSource: 'codex_github',
              officialUrl: getCodexReleasePageUrl(latestVersion),
            };
            if (releasePublishedAt === null && release.publishedAt !== null) releasePublishedAt = release.publishedAt;
          } catch {}
        }
        state = {
          ...state,
          latestVersion,
          releaseOverview,
          releasePublishedAt,
          updateAvailable,
          status: 'success',
          checkedAt: dependencies.now(),
        };
      } catch {
        state = {
          ...state,
          status: 'error',
          checkedAt: dependencies.now(),
        };
      } finally {
        activeCheck = null;
      }
      return getSnapshot();
    })();
    return activeCheck;
  };

  const initialize = (): void => {
    if (initialized) return;
    initialized = true;
    if (!activeCheck) refreshCurrentVersion();
    state = { ...state, status: 'checking' };
    void checkLatest();
  };

  const getReadySnapshot = async (): Promise<CodexVersionDto> => {
    initialize();
    if (!activeCheck) refreshCurrentVersion();
    return activeCheck ? activeCheck : getSnapshot();
  };

  return {
    initialize,
    getSnapshot,
    getReadySnapshot,
    checkLatest,
    refreshCurrentVersion,
  };
}

const CODEX_REGISTRY_URL = 'https://registry.npmjs.org/@openai%2Fcodex';

/**
 * 从 npm registry 的 time 字段读取指定版本的发布时间。
 * GitHub release 接口对匿名请求限流严重(常见 403),registry 是更稳定的发布时间来源。
 */
export async function fetchCodexNpmPublishedAt(version: string): Promise<number | null> {
  try {
    const response = await fetch(CODEX_REGISTRY_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'relay' },
      signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { time?: Record<string, string> };
    const raw = payload.time?.[version];
    const publishedAt = typeof raw === 'string' ? Date.parse(raw) : null;
    return Number.isFinite(publishedAt) ? publishedAt : null;
  } catch {
    return null;
  }
}

export const codexVersionService = createCodexVersionService({
  readCurrentVersion: readInstalledCodexVersion,
  fetchLatestVersion: fetchLatestCodexNpmVersion,
  fetchLatestPublishedAt: fetchCodexNpmPublishedAt,
  fetchRelease: fetchCodexRelease,
  now: Date.now,
});
