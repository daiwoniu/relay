const SEMANTIC_VERSION_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

export function formatEngineVersion(value: string | null): string | null {
  if (!value) return null;
  const version = SEMANTIC_VERSION_PATTERN.exec(value)?.[0];
  return version ? `v${version}` : value;
}

export function formatEngineUnavailableReason(stage: string | undefined, code: string, message: string): string {
  if (stage === 'not_installed') return '未安装';
  if (stage === 'installed_auth_required') return '未登录';
  if (stage === 'protocol_incompatible') return '协议不兼容';
  if (stage === 'readiness_stale') return '待复验';
  if (stage === 'readiness_failed') return '未就绪';
  if (code.includes('NOT_INSTALLED') || message.includes('未安装')) return '未安装';
  if (code.includes('AUTH') || message.includes('认证') || message.includes('登录')) return '未登录';
  if (code.includes('NOT_READY') || message.includes('未就绪') || message.includes('readiness')) return '未就绪';
  return '不可用';
}
