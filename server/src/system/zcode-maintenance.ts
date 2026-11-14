import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import type { EngineMaintenanceStatusDto } from '../contracts/index.js';
import { compareCodexVersions } from './codex-version.js';
import type { EngineMaintenanceAdapter } from '../engine/maintenance.js';
import { resolveZcodeAppServerEntry } from '../zcode/transport.js';
import { zcodeProcessManager } from '../zcode/process-manager.js';
import { engineStatusService } from './engine-status.js';

export interface ZcodeMaintenanceDependencies {
  /** 显式注入安装入口探测,默认读 ZCode 桌面安装路径。 */
  resolveEntry?: () => string | null;
  readDesktopVersion?: () => string | null;
  readDesktopInstalledAt?: () => number | null;
  /** 进程存活探测,默认查共享 app-server 管理器。 */
  readProcessLive?: () => boolean;
}

/**
 * 读取 ZCode.exe 的修改时间作为安装指纹;不可用时返回 NaN(恒不等,每次重新读取版本)。
 * 桌面端升级会替换 exe,指纹失配让已安装版本/安装时间缓存自动失效。
 */
function readDesktopExeMtimeMs(entry: string | null): number {
  if (!entry || process.platform !== 'win32') return Number.NaN;
  try {
    const exePath = path.resolve(path.dirname(entry), '..', '..', 'ZCode.exe');
    if (!fs.existsSync(exePath)) return Number.NaN;
    return fs.statSync(exePath).mtimeMs;
  } catch {
    return Number.NaN;
  }
}

/**
 * 从 ZCode 桌面安装目录读取可见版本:glm CLI bundle 硬编码 `x.y.z` 版本常量,
 * 提取首个语义版本串;读不到返回 null(unknown)。
 */
function readDesktopVersionDefault(entry: string | null): string | null {
  if (!entry) return null;
  try {
    const bundle = fs.readFileSync(entry, 'utf8');
    const match = bundle.match(/\b\d+\.\d+\.\d+\b/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * 从 ZCode 桌面应用可执行文件读取 Windows 文件版本,这是已安装版本最权威的来源
 * (bundle 内硬编码版本常量常是占位值,如 0.0.0)。仅在 Windows 且可定位 ZCode.exe 时有效。
 */
function readDesktopVersionFromExe(entry: string | null): string | null {
  if (!entry || process.platform !== 'win32') return null;
  try {
    const exePath = path.resolve(path.dirname(entry), '..', '..', 'ZCode.exe');
    if (!fs.existsSync(exePath)) return null;
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Item -LiteralPath ${JSON.stringify(exePath)}).VersionInfo.FileVersion`,
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    // Windows FileVersion 是 major.minor.build.revision 四段,语义版本只取前三段,
    // 才能与官网 changelog 的三段版本号比较并正确判定是否有新版。
    const match = out.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * 从 ZCode 桌面应用可执行文件读取安装时间,取文件创建时间(birthtime),
 * 不可用时回退目录修改时间。这是已安装时间最权威的来源。
 */
function readDesktopInstalledAt(entry: string | null): number | null {
  if (!entry || process.platform !== 'win32') return null;
  try {
    const exePath = path.resolve(path.dirname(entry), '..', '..', 'ZCode.exe');
    if (!fs.existsSync(exePath)) return null;
    const stat = fs.statSync(exePath);
    const candidate = stat.birthtimeMs || stat.mtimeMs;
    return candidate ? Math.round(candidate) : null;
  } catch {
    return null;
  }
}

/**
 * 从 ZCode 官网 changelog 解析最新发布版本号。
 * ZCode 桌面应用是 Electron 打包,内置 electron-updater 的更新服务器指向开发机(localhost),
 * 本机不可达;官网 changelog 是公开且稳定的最新版来源。页面按时间倒序,首个版本块即最新。
 */
const ZCODE_CHANGELOG_URL = 'https://zcode.z.ai/changelog';

/**
 * release 块结构为「版本号 badge</span><span …>发布于 2026年9月19日」:
 * 版本号与「发布于」之间夹着 HTML 标签,且日期为中文年月日、月和日不补零。
 * 版本号后紧跟「发布于」,因此不会匹配到 JS 资源名里的随机数字。
 */
const ZCODE_RELEASE_PATTERN = /(\d+\.\d+\.\d+)(?:\s*<[^>]*>\s*)*发布于\s*(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/;

type ZcodeReleaseCounts = {
  features: number;
  improvements: number;
  fixes: number;
  documentation: number;
  chores: number;
};

/**
 * 统计最新 release 块内各分类的更新条目数。该块以「Release vX.Y.Z」标题开始,
 * 之后是「新功能」「问题修复」等分类标题及各自条目列表;下一个旧版本块以
 * 「ZCode X.Y.Z 版本发布」开始,据此界定范围,避免把历史版本条目算进来。
 */
function parseZcodeReleaseCounts(text: string, version: string): ZcodeReleaseCounts | null {
  const headings = [...text.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)]
    .map((match) => ({ title: match[1].trim(), index: match.index ?? 0 }));
  const escaped = version.replace(/\./g, '\\.');
  const start = headings.findIndex((item) => new RegExp(`^Release\\s+v?${escaped}$`).test(item.title));
  if (start < 0) return null;
  const nextRelease = headings.findIndex(
    (item, index) => index > start && /^ZCode\s+\d+\.\d+\.\d+\s+版本发布$/.test(item.title),
  );
  const end = nextRelease > 0 ? headings[nextRelease].index : text.length;
  const counts: ZcodeReleaseCounts = { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 };
  for (let index = start + 1; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading.index >= end) break;
    const sectionEnd = index + 1 < headings.length ? Math.min(headings[index + 1].index, end) : end;
    const items = (text.slice(heading.index, sectionEnd).match(/<li[\s>]/g) || []).length;
    if (items === 0) continue;
    if (/修复/.test(heading.title)) counts.fixes += items;
    else if (/新功能|功能/.test(heading.title)) counts.features += items;
    else if (/优化|改进|提升|体验/.test(heading.title)) counts.improvements += items;
    else if (/文档/.test(heading.title)) counts.documentation += items;
    else counts.chores += items;
  }
  return counts;
}

async function fetchLatestZcodeVersion(timeoutMs = 8000): Promise<{
  version: string | null;
  publishedAt: number | null;
  counts: ZcodeReleaseCounts | null;
}> {
  try {
    const res = await fetch(ZCODE_CHANGELOG_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Relay' },
    });
    if (!res.ok) return { version: null, publishedAt: null, counts: null };
    const text = await res.text();
    const released = text.match(ZCODE_RELEASE_PATTERN);
    if (!released) {
      // 页面为 SPA 渲染,解析不出「版本号 + 发布日期」时宁可返回未知:
      // 裸匹配 /(\d+\.\d+\.\d+)/ 会把 JS 资源名里的随机数字误报成官方版本号。
      return { version: null, publishedAt: null, counts: null };
    }
    const publishedAt = new Date(Number(released[2]), Number(released[3]) - 1, Number(released[4])).getTime();
    return {
      version: released[1],
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      counts: parseZcodeReleaseCounts(text, released[1]),
    };
  } catch {
    return { version: null, publishedAt: null, counts: null };
  }
}

export class ZcodeMaintenanceAdapter implements EngineMaintenanceAdapter {
  readonly id = 'zcode' as const;
  private latestVersion: string | null = null;
  private latestCheckStatus: 'idle' | 'success' | 'error' = 'idle';
  private latestCheckedAt: number | null = null;
  private latestPublishedAt: number | null = null;
  private latestOverviewCounts: ZcodeReleaseCounts | null = null;
  /** 已安装版本缓存携带 exe mtime 指纹:桌面端升级替换 exe 后指纹失配,自动重新读取。 */
  private installedVersionCache: { exeMtimeMs: number; version: string | null } | null = null;
  private installedAtCache: { exeMtimeMs: number; installedAt: number | null } | null = null;

  constructor(private readonly dependencies: ZcodeMaintenanceDependencies) {}

  getStatus(): Promise<EngineMaintenanceStatusDto> {
    return this.project();
  }

  async checkLatest(): Promise<EngineMaintenanceStatusDto> {
    this.latestCheckedAt = Date.now();
    try {
      const latest = await fetchLatestZcodeVersion();
      if (latest.version) {
        this.latestVersion = latest.version;
        this.latestPublishedAt = latest.publishedAt;
        this.latestOverviewCounts = latest.counts;
        this.latestCheckStatus = 'success';
      } else {
        this.latestCheckStatus = 'error';
      }
    } catch {
      this.latestCheckStatus = 'error';
    }
    return this.project();
  }

  private async project(): Promise<EngineMaintenanceStatusDto> {
    const resolveEntry = this.dependencies.resolveEntry;
    const entry = resolveEntry ? resolveEntry() : resolveZcodeAppServerEntry();
    const exeMtimeMs = readDesktopExeMtimeMs(entry);
    const installedVersion = this.installedVersionCache?.exeMtimeMs === exeMtimeMs
      ? this.installedVersionCache.version
      : (this.installedVersionCache = {
          exeMtimeMs,
          version: this.dependencies.readDesktopVersion?.() ?? readDesktopVersionFromExe(entry) ?? readDesktopVersionDefault(entry),
        }).version;
    const installedAt = this.installedAtCache?.exeMtimeMs === exeMtimeMs
      ? this.installedAtCache.installedAt
      : (this.installedAtCache = { exeMtimeMs, installedAt: this.dependencies.readDesktopInstalledAt?.() ?? readDesktopInstalledAt(entry) }).installedAt;
    const availability = engineStatusService.getZcodeAvailability();
    const processLive = this.dependencies.readProcessLive?.() ?? zcodeProcessManager.hasLiveProcess;
    const updateAvailable = this.latestVersion && installedVersion
      ? compareCodexVersions(this.latestVersion, installedVersion) > 0
      : null;
    // Electron 桌面应用不经 npm 分发,Relay 不执行安装/升级事务;维护面板只读展示。
    return {
      engineId: 'zcode',
      label: 'ZCode',
      installedVersion,
      installedAt,
      runningVersion: null,
      latestVersion: this.latestVersion,
      releaseOverview: this.latestOverviewCounts && updateAvailable === true
        ? {
            sourceStatus: 'available',
            counts: this.latestOverviewCounts,
            topics: [],
            officialSource: 'zcode_changelog',
            officialUrl: ZCODE_CHANGELOG_URL,
          }
        : null,
      releasePublishedAt: this.latestPublishedAt,
      updateAvailable,
      latestCheckStatus: this.latestCheckStatus,
      latestCheckedAt: this.latestCheckedAt,
      installSource: entry ? 'desktop' : 'unknown',
      activeTaskCount: 0,
      activeInstanceCount: processLive ? 1 : 0,
      instanceVersions: [],
      readiness: availability.available ? 'ready' : entry ? 'failed' : 'unknown',
      readinessCheckedAt: null,
      availabilityStage: !entry ? 'not_installed' : availability.available ? 'ready' : 'readiness_failed',
      statusMessage: availability.available
        ? processLive ? 'ZCode 已安装，app-server 运行中' : 'ZCode 已安装，会话发送时按需启动'
        : entry ? 'ZCode 已安装，readiness 检查失败' : '未检测到 ZCode 桌面应用',
      loginCommand: null,
      recommendedAction: null,
      actions: [
        {
          action: 'recheck' as const,
          label: '重新检测',
          enabled: !availability.available,
          reason: availability.available ? 'ZCode 当前可用' : null,
          interruptsActiveTasks: false,
        },
      ],
    };
  }
}
