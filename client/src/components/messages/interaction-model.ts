import type { ApprovalAction } from '../../generated/relay-contracts.ts';

export interface McpChoice {
  value: string;
  label: string;
}

const DEVICE_TYPE_LABELS: Record<string, string> = { desktop: '电脑', phone: '手机', tablet: '平板' };

const RESOLVED_ACTION_LABELS: Record<string, string> = {
  accept: '已允许',
  accept_for_session: '本会话已允许',
  decline: '已拒绝',
  cancel: '已取消',
  submit: '已提交',
  submitted: '已提交',
  invalidated: '已失效',
};

// 结果位只陈述授权操作的结局；resolved_elsewhere 由引擎侧结束，没有可展示的操作结果
export function getApprovalResultLabel(details: Record<string, any>): string | null {
  const action = details.resolvedAction;
  if (typeof action !== 'string' || !action) return null;
  if (action === 'resolved_elsewhere') return '结果未记录';
  return RESOLVED_ACTION_LABELS[action] ?? '已处理';
}

// 来源位只陈述决定从哪来；按服务端记录的设备标识与本机比对，旧票据没有设备标识时按本账号操作降级为“由你”
export function getApprovalSourceLabel(details: Record<string, any>, localDeviceId: string | null): string | null {
  const source = details.decisionSource;
  if (source === 'session_trust') return '由会话信任自动允许';
  if (source === 'project_trust') return '由项目信任自动允许';
  if (source === 'resolved_elsewhere') return '由引擎侧结束';
  if (source !== 'user') return null;
  const decidedDeviceId = typeof details.decidedByDeviceId === 'string' ? details.decidedByDeviceId : '';
  if (decidedDeviceId && localDeviceId && decidedDeviceId !== localDeviceId) {
    const deviceLabel = DEVICE_TYPE_LABELS[String(details.decidedByDeviceType ?? '')];
    return deviceLabel ? `由其他设备（${deviceLabel}）` : '由其他设备';
  }
  return '由你';
}

export function getSafeMcpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const DEFAULT_APPROVAL_ACTIONS: ApprovalAction[] = ['accept', 'accept_for_session', 'decline', 'cancel'];
const CODEX_DECISION_ACTIONS: Record<string, ApprovalAction> = {
  accept: 'accept',
  acceptForSession: 'accept_for_session',
  decline: 'decline',
  cancel: 'cancel',
};

export function getAvailableApprovalActions(details: Record<string, any>): ApprovalAction[] {
  if (!Array.isArray(details.availableDecisions)) {
    return [...DEFAULT_APPROVAL_ACTIONS];
  }
  const result: ApprovalAction[] = [];
  for (const decision of details.availableDecisions) {
    if (typeof decision !== 'string') continue;
    const action = CODEX_DECISION_ACTIONS[decision];
    if (action && !result.includes(action)) result.push(action);
  }
  return result;
}

export function getApprovalDecisionAvailability(details: Record<string, any>): {
  accept: boolean;
  acceptForSession: boolean;
  decline: boolean;
  cancel: boolean;
} {
  const actions = new Set(getAvailableApprovalActions(details));
  return {
    accept: actions.has('accept'),
    acceptForSession: actions.has('accept_for_session'),
    decline: actions.has('decline'),
    cancel: actions.has('cancel'),
  };
}

export function getMcpChoices(field: Record<string, any>): { choices: McpChoice[]; multiple: boolean } | null {
  const source = field.type === 'array' && field.items && typeof field.items === 'object' ? field.items : field;
  if (Array.isArray(source.enum)) {
    return {
      choices: source.enum.map((value: unknown, index: number) => ({
        value: String(value),
        label: String(source.enumNames?.[index] ?? value),
      })),
      multiple: field.type === 'array',
    };
  }
  if (Array.isArray(source.oneOf)) {
    const choices = source.oneOf.flatMap((option: unknown) => {
        if (!option || typeof option !== 'object' || !('const' in option)) return [];
        const value = String((option as Record<string, unknown>).const);
        return [{ value, label: String((option as Record<string, unknown>).title ?? value) }];
      });
    if (choices.length === 0) return null;
    return {
      choices,
      multiple: field.type === 'array',
    };
  }
  return null;
}

export function isSupportedMcpForm(details: Record<string, any>): boolean {
  if (details.mode === 'url') return true;
  if (details.mode !== 'form') return false;
  const schema = details.requestedSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (schema.type !== undefined && schema.type !== 'object') return false;
  if (['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'patternProperties'].some((key) => key in schema)) {
    return false;
  }
  const properties = schema.properties;
  const required = schema.required;
  if (required !== undefined && (!Array.isArray(required) || required.some((name: unknown) => typeof name !== 'string'))) {
    return false;
  }
  if (properties === undefined) return !required || required.length === 0;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
  if (required?.some((name: string) => !(name in properties))) return false;
  return Object.values(properties).every((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const field = raw as Record<string, any>;
    if (getMcpChoices(field)) return true;
    return ['string', 'number', 'integer', 'boolean'].includes(String(field.type));
  });
}

export function buildMcpDefaults(details: Record<string, any>): Record<string, unknown> {
  const properties = details.requestedSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  return Object.fromEntries(Object.entries(properties).flatMap(([name, raw]) => {
    if (!raw || typeof raw !== 'object' || !('default' in raw)) return [];
    return [[name, (raw as Record<string, unknown>).default]];
  }));
}

export function isMcpFormComplete(details: Record<string, any>, formData: Record<string, unknown>): boolean {
  if (!isSupportedMcpForm(details) || details.mode === 'url') return isSupportedMcpForm(details);
  const required = Array.isArray(details.requestedSchema?.required) ? details.requestedSchema.required : [];
  return required.every((name: unknown) => {
    const value = formData[String(name)];
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}

export function getMcpDirectSubmission(details: Record<string, any>): { formData: Record<string, unknown> } | null {
  if (details.mode === 'url') return { formData: {} };
  if (!isSupportedMcpForm(details)) return null;
  const formData = buildMcpDefaults(details);
  return isMcpFormComplete(details, formData) ? { formData } : null;
}
