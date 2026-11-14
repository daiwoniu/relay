import type { ApprovalTrustDuration, ApprovalTrustStateDto } from '../../generated/relay-contracts.ts';
import { deriveEffectiveApprovalTrust } from '../../stores/approval-trust.ts';

export type ApprovalTrustChoiceDetailTone = 'muted' | 'success' | 'warning';

function formatRemaining(expiresAt: number, now: number, updatedAt?: number): string {
  const configuredDuration = updatedAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, expiresAt - updatedAt);
  const remaining = Math.min(Math.max(0, expiresAt - now), configuredDuration);
  if (remaining < 60_000) return `${Math.ceil(remaining / 1_000)} 秒`;
  const totalMinutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}` : `${minutes} 分钟`;
}

export function getApprovalTrustRefreshDelay(expiresAtValues: Array<number | null>, now: number): number | null {
  const delays = expiresAtValues
    .filter((expiresAt): expiresAt is number => expiresAt !== null && expiresAt > now)
    .map((expiresAt) => {
      const remaining = expiresAt - now;
      const precision = remaining <= 60_000 ? 1_000 : 60_000;
      return remaining % precision || precision;
    });
  return delays.length > 0 ? Math.min(...delays) : null;
}

function activeTrustedSetting(
  setting: ApprovalTrustStateDto['projectSetting'] | ApprovalTrustStateDto['sessionSetting'] | undefined,
  now: number,
) {
  return setting?.mode === 'trusted' && (setting.expiresAt === null || setting.expiresAt > now)
    ? setting
    : null;
}

function activeManualSetting(setting: ApprovalTrustStateDto['sessionSetting'] | undefined, now: number): boolean {
  return setting?.mode === 'manual' && (setting.expiresAt === null || setting.expiresAt > now);
}

function trustDetail(
  prefix: string,
  setting: NonNullable<ApprovalTrustStateDto['projectSetting'] | ApprovalTrustStateDto['sessionSetting']>,
  now: number,
): {
  label: string;
  tone: ApprovalTrustChoiceDetailTone;
} {
  if (setting.expiresAt === null) return { label: `${prefix} · 长期有效`, tone: 'success' };
  return {
    label: `${prefix} · 剩余 ${formatRemaining(setting.expiresAt, now, setting.updatedAt)}`,
    tone: setting.expiresAt - now < 10 * 60_000 ? 'warning' : 'success',
  };
}

export function getApprovalTrustChoiceDetail(
  state: ApprovalTrustStateDto | null,
  scope: 'session' | 'project',
  now = Date.now(),
): { label: string; tone: ApprovalTrustChoiceDetailTone } {
  const projectTrust = activeTrustedSetting(state?.projectSetting, now);
  if (scope === 'project') {
    return projectTrust
      ? trustDetail('当前生效', projectTrust, now)
      : { label: '当前项目未启用信任', tone: 'muted' };
  }

  const sessionTrust = activeTrustedSetting(state?.sessionSetting, now);
  if (sessionTrust) return trustDetail('当前生效', sessionTrust, now);
  if (activeManualSetting(state?.sessionSetting, now)) {
    return { label: '当前生效 · 逐次由你确认', tone: 'muted' };
  }
  return projectTrust
    ? trustDetail('继承项目信任', projectTrust, now)
    : { label: '当前跟随项目 · 人工审核', tone: 'muted' };
}

export function getApprovalTrustDurationChoice(
  setting: ApprovalTrustStateDto['sessionSetting'] | undefined,
  now = Date.now(),
): ApprovalTrustDuration | null {
  if (!setting || setting.mode !== 'trusted') return null;
  if (setting.expiresAt === null) return 'permanent';
  if (setting.expiresAt <= now) return null;
  const duration = setting.expiresAt - setting.updatedAt;
  return duration > 4 * 60 * 60_000 ? 'eight_hours' : 'one_hour';
}

export function getApprovalTrustStatusPresentation(state: ApprovalTrustStateDto | null, now = Date.now()) {
  const effective = deriveEffectiveApprovalTrust(state, now);
  if (effective.sessionOverridesProject) {
    return { label: '会话人工覆盖项目信任', trusted: false };
  }
  if (!effective.trusted) return { label: '人工审核', trusted: false };
  const scope = effective.source === 'session_trust' ? '会话信任' : '项目信任';
  const setting = effective.source === 'session_trust' ? state?.sessionSetting : state?.projectSetting;
  const duration = effective.expiresAt === null
    ? '永久'
    : `剩余 ${formatRemaining(effective.expiresAt, now, setting?.updatedAt)}`;
  return { label: `${scope} · ${duration}`, trusted: true };
}
