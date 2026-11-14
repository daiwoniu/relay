import type { EngineInteractionAdapter } from '../facets.js';
import {
  defineNormalizedInteraction,
  type InteractionAction,
  type NormalizedInteractionKind,
} from '../interactions.js';

type RecordValue = Record<string, any>;

const ACP_ACTIONS: Record<string, InteractionAction> = {
  allow_once: 'accept_once',
  allow_always: 'accept_for_session',
  reject_once: 'decline',
};
const ACTION_TO_ACP_KIND: Partial<Record<InteractionAction, string>> = {
  accept_once: 'allow_once',
  accept_for_session: 'allow_always',
  decline: 'reject_once',
};

const DEFAULT_COMMAND_TOOLS = /^(?:bash|shell|terminal|execute|command)$/i;
const DEFAULT_FILE_TOOLS = /^(?:write|edit|multiedit|applypatch|notebookedit|createfile|deletefile|movefile)$/i;
const DEFAULT_NETWORK_TOOLS = /^(?:webfetch|websearch|fetch|http|browser|network)$/i;

export interface AcpInteractionOptions {
  toolNameFromMeta?: (meta: RecordValue) => string | undefined;
  commandTools?: RegExp;
  fileTools?: RegExp;
  networkTools?: RegExp;
  toolKindMapping?: (kind: unknown) => Extract<NormalizedInteractionKind, 'command' | 'file' | 'permissions'> | undefined;
}

function interactionKind(params: RecordValue, options: AcpInteractionOptions): {
  kind: Extract<NormalizedInteractionKind, 'command' | 'file' | 'permissions'>;
  toolName?: string;
  rawInput: RecordValue;
} {
  const toolCall = params.toolCall && typeof params.toolCall === 'object' ? params.toolCall as RecordValue : {};
  const rawInput = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput as RecordValue : {};
  const metadata = toolCall._meta && typeof toolCall._meta === 'object' ? toolCall._meta as RecordValue : {};
  const toolName = options.toolNameFromMeta?.(metadata) ?? (typeof toolCall.title === 'string' ? toolCall.title : undefined);
  const commandTools = options.commandTools ?? DEFAULT_COMMAND_TOOLS;
  const fileTools = options.fileTools ?? DEFAULT_FILE_TOOLS;
  const kind = (toolName && commandTools.test(toolName)) || typeof rawInput.command === 'string'
    ? 'command'
    : (toolName && fileTools.test(toolName)) || typeof rawInput.path === 'string' || typeof rawInput.filePath === 'string'
      ? 'file'
      : options.toolKindMapping?.(toolCall.kind) ?? 'permissions';
  return { kind, toolName, rawInput };
}

export function createAcpInteractionAdapter(options: AcpInteractionOptions = {}): EngineInteractionAdapter {
  return {
    normalize(request) {
      if (request.method === 'session/request_permission') {
        const params = request.params as RecordValue;
        const { kind, toolName, rawInput } = interactionKind(params, options);
        const title = kind === 'command'
          ? '需要授权执行命令'
          : kind === 'file'
            ? '需要授权修改文件'
            : toolName && (options.networkTools ?? DEFAULT_NETWORK_TOOLS).test(toolName)
              ? '需要授权访问网络'
              : '需要授权使用工具';
        const availableOptions = Array.isArray(params.options) ? params.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return [];
          const value = option as RecordValue;
          return typeof value.kind === 'string' && typeof value.optionId === 'string' && ACP_ACTIONS[value.kind]
            ? [{ kind: value.kind, optionId: value.optionId, ...(typeof value.name === 'string' ? { name: value.name } : {}) }]
            : [];
        }) : [];
        const availableActions = [...new Set([
          ...availableOptions.flatMap((option) => ACP_ACTIONS[option.kind] ? [ACP_ACTIONS[option.kind]] : []),
          'cancel' as const,
        ])] as InteractionAction[];
        return defineNormalizedInteraction({
          requestId: request.requestId,
          kind,
          snapshot: {
            title,
            command: typeof rawInput.command === 'string' ? rawInput.command : undefined,
            reason: typeof rawInput.description === 'string' ? rawInput.description : undefined,
            toolName,
            rawInput: Object.fromEntries(Object.entries(rawInput).filter(([key, value]) => ['command', 'description', 'path', 'filePath'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value))),
            networkApprovalContext: kind === 'permissions' && toolName && (options.networkTools ?? DEFAULT_NETWORK_TOOLS).test(toolName) ? { toolName } : undefined,
            availableDecisions: [...availableOptions.map((option) => option.kind === 'allow_once' ? 'accept' : option.kind === 'allow_always' ? 'acceptForSession' : 'decline'), 'cancel'],
          },
          availableActions,
        });
      }
      if (request.method === 'session/request_user_input') {
        return defineNormalizedInteraction({ requestId: request.requestId, kind: 'user_input', snapshot: { ...request.params, title: '引擎需要你的回答' }, availableActions: ['submit', 'cancel'] });
      }
      return defineNormalizedInteraction({ requestId: request.requestId, kind: 'unknown', snapshot: { title: '需要处理客户端请求' }, availableActions: [] });
    },
    buildResponse(request, command) {
      if (request.method === 'session/request_permission') {
        if (command.action === 'cancel') return { outcome: { outcome: 'cancelled' } };
        const requestedKind = ACTION_TO_ACP_KIND[command.action];
        const optionsList = Array.isArray(request.params.options) ? request.params.options : [];
        const selected = optionsList.find((option) => option && typeof option === 'object' && (option as RecordValue).kind === requestedKind && typeof (option as RecordValue).optionId === 'string') as RecordValue | undefined;
        if (!requestedKind || !selected) throw new Error('该授权决定当前不可用');
        return { outcome: { outcome: 'selected', optionId: selected.optionId } };
      }
      if (request.method === 'session/request_user_input') {
        if (command.action === 'cancel') return { outcome: { outcome: 'cancelled' } };
        if (command.action !== 'submit') throw new Error('该输入决定当前不可用');
        return { answers: command.answers || {} };
      }
      throw new Error(`暂不支持处理引擎请求：${request.method}`);
    },
  };
}
