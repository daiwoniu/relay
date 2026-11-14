import type {
  EngineMaintenanceInstallSource,
  EngineMaintenanceStatusDto,
} from '../contracts/index.js';
import type { EngineMaintenanceAdapter } from '../engine/maintenance.js';

export interface CodeBuddyVersionSnapshot {
  installedVersion: string | null;
  latestVersion: string | null;
  releaseOverview: EngineMaintenanceStatusDto['releaseOverview'];
  releasePublishedAt: number | null;
  updateAvailable: boolean | null;
  status: EngineMaintenanceStatusDto['latestCheckStatus'];
  checkedAt: number | null;
}

export interface CodeBuddyMaintenanceDependencies {
  getVersionSnapshot(): Promise<CodeBuddyVersionSnapshot> | CodeBuddyVersionSnapshot;
  checkLatestVersion(): Promise<CodeBuddyVersionSnapshot>;
  readInstallSource(): EngineMaintenanceInstallSource;
  readInstalledAt?: () => number | null;
  readInstanceSummary(): { activeInstanceCount: number; versions: Array<{ version: string | null; count: number }> };
  readReadiness(): Promise<{ readiness: EngineMaintenanceStatusDto['readiness']; checkedAt: number | null; availabilityStage?: EngineMaintenanceStatusDto['availabilityStage']; message?: string }> | { readiness: EngineMaintenanceStatusDto['readiness']; checkedAt: number | null; availabilityStage?: EngineMaintenanceStatusDto['availabilityStage']; message?: string };
}

export class CodeBuddyMaintenanceAdapter implements EngineMaintenanceAdapter {
  readonly id = 'codebuddy' as const;

  constructor(private readonly dependencies: CodeBuddyMaintenanceDependencies) {}

  async getStatus(): Promise<EngineMaintenanceStatusDto> {
    return await this.project(await this.dependencies.getVersionSnapshot());
  }

  async checkLatest(): Promise<EngineMaintenanceStatusDto> {
    return await this.project(await this.dependencies.checkLatestVersion());
  }

  private async project(version: CodeBuddyVersionSnapshot): Promise<EngineMaintenanceStatusDto> {
    const summary = this.dependencies.readInstanceSummary();
    const installSource = this.dependencies.readInstallSource();
    const readiness = await this.dependencies.readReadiness();
    const availabilityStage = readiness.availabilityStage
      ?? (readiness.readiness === 'ready' ? 'ready' : readiness.readiness === 'failed' ? 'readiness_failed' : 'readiness_stale');
    const installed = Boolean(version.installedVersion);
    const installEnabled = !installed;
    const recheckEnabled = installed && summary.activeInstanceCount === 0 && readiness.readiness !== 'ready';
    const upgradeEnabled = installSource === 'official_npm_global'
      && summary.activeInstanceCount === 0
      && readiness.readiness !== 'failed'
      && version.status === 'success'
      && version.updateAvailable === true;
    const reason = installSource !== 'official_npm_global'
      ? '无法确认是官方 npm 全局安装，请在终端手动升级'
      : summary.activeInstanceCount > 0
        ? '存在 CodeBuddy 活动实例，释放全部实例后才能升级'
        : readiness.readiness === 'failed'
          ? availabilityStage === 'readiness_failed' && readiness.message ? readiness.message : 'CodeBuddy readiness 失败，请在终端修复后运行 npm run restart'
        : version.status !== 'success'
          ? '请先成功检查官方最新稳定版'
          : version.updateAvailable !== true
            ? '当前已是官方最新稳定版'
            : null;
    return {
      engineId: 'codebuddy',
      label: 'CodeBuddy',
      installedVersion: version.installedVersion,
      installedAt: this.dependencies.readInstalledAt?.() ?? null,
      runningVersion: null,
      latestVersion: version.latestVersion,
      releaseOverview: version.releaseOverview,
      releasePublishedAt: version.releasePublishedAt,
      updateAvailable: version.updateAvailable,
      latestCheckStatus: version.status,
      latestCheckedAt: version.checkedAt,
      installSource,
      activeTaskCount: 0,
      activeInstanceCount: summary.activeInstanceCount,
      instanceVersions: summary.versions,
      readiness: readiness.readiness,
      readinessCheckedAt: readiness.checkedAt,
      availabilityStage: !installed ? 'not_installed' : availabilityStage,
      statusMessage: !installed ? '未安装 CodeBuddy CLI' : availabilityStage === 'ready' ? 'CodeBuddy 可用' : availabilityStage === 'installed_auth_required' ? 'CodeBuddy 已安装，需在终端完成登录' : availabilityStage === 'readiness_stale' ? 'CodeBuddy readiness 记录已过期，等待重新检测' : availabilityStage === 'readiness_failed' && readiness.message ? readiness.message : 'CodeBuddy readiness 检测失败',
      loginCommand: installed && availabilityStage === 'installed_auth_required' ? 'codebuddy' : null,
      recommendedAction: installEnabled ? 'install' : upgradeEnabled ? 'upgrade' : null,
      actions: [
        ...(installEnabled ? [{ action: 'install' as const, label: '安装 CodeBuddy', enabled: true, reason: null, interruptsActiveTasks: false }] : []),
        ...(installed ? [{
          action: 'recheck' as const,
          label: '重新检测',
          enabled: recheckEnabled,
          reason: summary.activeInstanceCount > 0 ? '存在 CodeBuddy 活动实例，结束后才能重新检测' : readiness.readiness === 'ready' ? 'CodeBuddy 当前可用' : null,
          interruptsActiveTasks: false,
        }] : []), {
        action: 'upgrade',
        label: '升级 CodeBuddy',
        enabled: upgradeEnabled,
        reason,
        interruptsActiveTasks: false,
      }],
    };
  }
}
