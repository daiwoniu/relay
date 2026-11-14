import type {
  CodexVersionDto,
  EngineMaintenanceInstallSource,
  EngineMaintenanceStatusDto,
} from '../contracts/index.js';
import type { EngineMaintenanceAdapter } from '../engine/maintenance.js';

export interface CodexMaintenanceDependencies {
  getVersionSnapshot(): Promise<CodexVersionDto> | CodexVersionDto;
  checkLatestVersion(): Promise<CodexVersionDto>;
  readRunningVersion(): Promise<string | null> | string | null;
  readActiveTaskCount(): number | Promise<number>;
  readInstallSource(): EngineMaintenanceInstallSource;
  readInstalledAt?: () => number | null;
  readReadiness(): Promise<{ readiness: EngineMaintenanceStatusDto['readiness']; checkedAt: number | null }> | { readiness: EngineMaintenanceStatusDto['readiness']; checkedAt: number | null };
}

export class CodexMaintenanceAdapter implements EngineMaintenanceAdapter {
  readonly id = 'codex' as const;

  constructor(private readonly dependencies: CodexMaintenanceDependencies) {}

  async getStatus(): Promise<EngineMaintenanceStatusDto> {
    return this.project(await this.dependencies.getVersionSnapshot());
  }

  async checkLatest(): Promise<EngineMaintenanceStatusDto> {
    return this.project(await this.dependencies.checkLatestVersion());
  }

  private async project(version: CodexVersionDto): Promise<EngineMaintenanceStatusDto> {
    const activeTaskCount = await this.dependencies.readActiveTaskCount();
    const installSource = this.dependencies.readInstallSource();
    const runningVersion = await this.dependencies.readRunningVersion();
    const readiness = await this.dependencies.readReadiness();
    const installed = Boolean(version.currentVersion);
    const installEnabled = !installed;
    const restartEnabled = readiness.readiness === 'ready';
    const upgradeEnabled = installSource === 'official_npm_global'
      && activeTaskCount === 0
      && version.status === 'success'
      && version.updateAvailable === true;
    const upgradeReason = installSource !== 'official_npm_global'
      ? '无法确认是官方 npm 全局安装，请在终端手动升级'
      : activeTaskCount > 0
        ? '存在 Codex 活动任务，完成或停止后才能升级'
        : version.status !== 'success'
          ? '请先成功检查官方最新稳定版'
          : version.updateAvailable !== true
            ? '当前已是官方最新稳定版'
            : null;
    return {
      engineId: 'codex',
      label: 'Codex',
      installedVersion: version.currentVersion,
      installedAt: this.dependencies.readInstalledAt?.() ?? null,
      runningVersion,
      latestVersion: version.latestVersion,
      releaseOverview: version.releaseOverview,
      releasePublishedAt: version.releasePublishedAt ?? null,
      updateAvailable: version.updateAvailable,
      latestCheckStatus: version.status,
      latestCheckedAt: version.checkedAt,
      installSource,
      activeTaskCount,
      activeInstanceCount: runningVersion ? 1 : 0,
      instanceVersions: runningVersion ? [{ version: runningVersion, count: 1 }] : [],
      readiness: readiness.readiness,
      readinessCheckedAt: readiness.checkedAt,
      availabilityStage: !installed ? 'not_installed' : readiness.readiness === 'ready' ? 'ready' : 'installed_auth_required',
      statusMessage: !installed ? '未安装 Codex CLI' : readiness.readiness === 'ready' ? 'Codex 可用' : 'Codex 已安装，需在终端完成登录或修复 app-server',
      loginCommand: installed && readiness.readiness !== 'ready' ? 'codex' : null,
      recommendedAction: installEnabled ? 'install' : upgradeEnabled ? 'upgrade_and_restart' : null,
      actions: [
        ...(installEnabled ? [{ action: 'install' as const, label: '安装 Codex', enabled: true, reason: null, interruptsActiveTasks: false }] : []),
        {
          action: 'restart',
          label: '重启 Codex',
          enabled: restartEnabled,
          reason: restartEnabled ? null : 'Codex app-server 当前未就绪',
          interruptsActiveTasks: activeTaskCount > 0,
        },
        {
          action: 'upgrade_and_restart',
          label: '升级并重启 Codex',
          enabled: upgradeEnabled,
          reason: upgradeReason,
          interruptsActiveTasks: false,
        },
      ],
    };
  }
}
