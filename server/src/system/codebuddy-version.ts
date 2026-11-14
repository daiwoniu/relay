import { compareCodexVersions } from './codex-version.js';
import type { CodeBuddyVersionSnapshot } from './codebuddy-maintenance.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractCodeBuddyReleaseOverview } from './codebuddy-release-overview.js';

const LATEST_URL = 'https://registry.npmjs.org/@tencent-ai%2Fcodebuddy-code/latest';
const RELEASE_PAGE_PREFIX = 'https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/release-notes/v';
const CHANGELOG_PAGE_URL = 'https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/CHANGELOG.md';
const VERSION_TIMEOUT_MS = 5_000;
const MAX_RELEASE_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_RELEASE_MARKDOWN_BYTES = 512 * 1024;

interface CodeBuddyReleaseMetadata {
  body: string;
  publishedAt: number | null;
  sourceStatus: 'available' | 'metadata_only';
}

function isCodeBuddyVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function getCodeBuddyReleasePageUrl(version: string): string {
  return `${RELEASE_PAGE_PREFIX}${encodeURIComponent(version)}.md`;
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('CodeBuddy release response exceeds size limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('CodeBuddy release response exceeds size limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function decodeEmbeddedMarkdown(html: string): string {
  const content = /"encoding":"base64","content":"([A-Za-z0-9+/=]+)"/.exec(html)?.[1];
  if (!content) throw new Error('CodeBuddy release notes content missing');
  if (content.length > Math.ceil(MAX_RELEASE_MARKDOWN_BYTES * 4 / 3) + 4) {
    throw new Error('CodeBuddy release markdown exceeds size limit');
  }
  const markdown = Buffer.from(content, 'base64');
  if (markdown.byteLength > MAX_RELEASE_MARKDOWN_BYTES) throw new Error('CodeBuddy release markdown exceeds size limit');
  return new TextDecoder('utf-8', { fatal: true }).decode(markdown);
}

export function extractCodeBuddyVersion(value: unknown): string | null {
  return /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z.-])/.exec(String(value || '').trim())?.[1] || null;
}

export function getCodeBuddyVersionCommand(
  platform = process.platform,
  comSpec = process.env.ComSpec,
): { file: string; args: string[] } {
  return platform === 'win32'
    ? { file: comSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'codebuddy.cmd --version'] }
    : { file: 'codebuddy', args: ['--version'] };
}

export function readInstalledCodeBuddyVersion(): string | null {
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const packageFile = path.join(directory, 'node_modules', '@tencent-ai', 'codebuddy-code', 'package.json');
    try {
      const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
      if (typeof version === 'string') return version;
    } catch {}
  }
  try {
    const command = getCodeBuddyVersionCommand();
    const output = execFileSync(command.file, command.args, {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const version = extractCodeBuddyVersion(output);
    if (version) return version;
  } catch {}
  return process.env.RELAY_CODEBUDDY_VERSION || null;
}

export async function fetchCodeBuddyRelease(version: string, fetchImpl: typeof fetch = fetch): Promise<CodeBuddyReleaseMetadata> {
  if (!isCodeBuddyVersion(version)) throw new Error('invalid CodeBuddy release version');
  const response = await fetchImpl(getCodeBuddyReleasePageUrl(version), {
    headers: { Accept: 'text/html', 'User-Agent': 'daiwoniu-relay' },
    signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
  });
  if (response.status === 404) {
    const changelogResponse = await fetchImpl(CHANGELOG_PAGE_URL, {
      headers: { Accept: 'text/html', 'User-Agent': 'daiwoniu-relay' },
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    });
    if (!changelogResponse.ok) throw new Error(`CodeBuddy changelog check failed: ${changelogResponse.status}`);
    const changelog = decodeEmbeddedMarkdown(await readResponseTextLimited(changelogResponse, MAX_RELEASE_PAGE_BYTES));
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^## \\[${escapedVersion}\\](?:\\s+-|\\s*$)`, 'm').test(changelog)) {
      throw new Error('CodeBuddy changelog missing version');
    }
    return { body: '', publishedAt: null, sourceStatus: 'metadata_only' };
  }
  if (!response.ok) throw new Error(`CodeBuddy release notes check failed: ${response.status}`);
  return {
    body: decodeEmbeddedMarkdown(await readResponseTextLimited(response, MAX_RELEASE_PAGE_BYTES)),
    publishedAt: null,
    sourceStatus: 'available',
  };
}

export function createCodeBuddyVersionService(dependencies: {
  readInstalledVersion(): string | null;
  fetchLatestVersion(): Promise<string>;
  fetchLatestPublishedAt?: (version: string) => Promise<number | null>;
  fetchRelease?: (version: string) => Promise<CodeBuddyReleaseMetadata>;
  now(): number;
}) {
  let state: CodeBuddyVersionSnapshot = {
    installedVersion: null,
    latestVersion: null,
    releaseOverview: null,
    releasePublishedAt: null,
    updateAvailable: null,
    status: 'idle',
    checkedAt: null,
  };
  let active: Promise<CodeBuddyVersionSnapshot> | null = null;
  const refreshInstalled = () => {
    const installedVersion = dependencies.readInstalledVersion();
    state = { ...state, installedVersion, updateAvailable: installedVersion && state.latestVersion ? compareCodexVersions(state.latestVersion, installedVersion) > 0 : null };
  };
  const snapshot = () => { refreshInstalled(); return { ...state }; };
  const checkLatest = () => {
    if (active) return active;
    refreshInstalled(); state = { ...state, status: 'checking' };
    active = (async () => {
      try {
        const latestVersion = await dependencies.fetchLatestVersion();
        if (!isCodeBuddyVersion(latestVersion)) throw new Error('invalid version');
        const updateAvailable = state.installedVersion ? compareCodexVersions(latestVersion, state.installedVersion) > 0 : null;
        let releaseOverview: CodeBuddyVersionSnapshot['releaseOverview'] = updateAvailable
          ? {
              sourceStatus: 'unavailable',
              counts: { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 },
              topics: [],
              officialSource: 'codebuddy_cnb',
              officialUrl: getCodeBuddyReleasePageUrl(latestVersion),
            }
          : null;
        let releasePublishedAt: number | null = null;
        if (dependencies.fetchLatestPublishedAt) {
          try { releasePublishedAt = await dependencies.fetchLatestPublishedAt(latestVersion); } catch {}
        }
        if (updateAvailable && dependencies.fetchRelease) {
          try {
            const release = await dependencies.fetchRelease(latestVersion);
            releaseOverview = release.sourceStatus === 'metadata_only' ? {
              sourceStatus: 'metadata_only',
              counts: { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 },
              topics: [],
              officialSource: 'codebuddy_cnb',
              officialUrl: CHANGELOG_PAGE_URL,
            } : {
              ...extractCodeBuddyReleaseOverview(release.body),
              officialSource: 'codebuddy_cnb',
              officialUrl: getCodeBuddyReleasePageUrl(latestVersion),
            };
            if (releasePublishedAt === null && release.publishedAt !== null) releasePublishedAt = release.publishedAt;
          } catch {}
        }
        state = { ...state, latestVersion, releaseOverview, releasePublishedAt, updateAvailable, status: 'success', checkedAt: dependencies.now() };
      } catch { state = { ...state, status: 'error', checkedAt: dependencies.now() }; }
      finally { active = null; }
      return snapshot();
    })();
    return active;
  };
  refreshInstalled();
  return { getSnapshot: snapshot, checkLatest, refreshInstalled };
}

const REGISTRY_URL = 'https://registry.npmjs.org/@tencent-ai%2Fcodebuddy-code';

/**
 * 从 npm registry 的 time 字段读取指定版本的发布时间。
 * CNB 发布说明页不携带发布时间,registry 的 time 是可靠来源。
 */
export async function fetchCodeBuddyNpmPublishedAt(version: string): Promise<number | null> {
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'daiwoniu-relay' },
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
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

export const codeBuddyVersionService = createCodeBuddyVersionService({
  readInstalledVersion: readInstalledCodeBuddyVersion,
  fetchLatestVersion: async () => {
    const response = await fetch(LATEST_URL, { headers: { Accept: 'application/json', 'User-Agent': 'daiwoniu-relay' }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`registry ${response.status}`);
    const payload = await response.json() as { version?: unknown };
    if (typeof payload.version !== 'string') throw new Error('missing version');
    return payload.version;
  },
  fetchLatestPublishedAt: fetchCodeBuddyNpmPublishedAt,
  fetchRelease: fetchCodeBuddyRelease,
  now: Date.now,
});
