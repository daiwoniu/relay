import type { EngineCapabilities } from './adapter.js';
import type { EngineId } from './types.js';

export interface EngineDefinition {
  id: EngineId;
  label: string;
  shortName: string;
  vendor: string;
  position: string;
  badgeColor: string;
  docsUrl: string;
  transport: 'codex-ws-rpc' | 'acp-stdio' | 'zcode-stdio';
  adapterKind: 'codex' | 'acp' | 'zcode';
  capabilities: EngineCapabilities;
  install: {
    packageName: string;
    executableCandidates: readonly string[];
  };
  acp?: {
    launchMode: 'codebuddy' | 'opencode';
    loginRequired: boolean;
    modelOptionKey: string;
  };
}

const SHARED_AGENT_CAPABILITIES: EngineCapabilities = {
  conversations: true,
  streaming: true,
  processItems: true,
  cancellation: true,
  interactions: true,
  tokenUsage: true,
  archive: false,
};

export const ENGINE_DEFINITIONS: Record<EngineId, EngineDefinition> = {
  codex: {
    id: 'codex',
    label: 'Codex',
    shortName: 'CX',
    vendor: 'OpenAI',
    position: '全球前沿的 AI 编程能力',
    badgeColor: '#111111',
    docsUrl: 'https://developers.openai.com/codex/',
    transport: 'codex-ws-rpc',
    adapterKind: 'codex',
    capabilities: { ...SHARED_AGENT_CAPABILITIES, archive: true },
    install: {
      packageName: '@openai/codex',
      executableCandidates: ['codex'],
    },
  },
  codebuddy: {
    id: 'codebuddy',
    label: 'CodeBuddy',
    shortName: 'CB',
    vendor: '腾讯云',
    position: '深耕国内开发者生态',
    badgeColor: '#006bea',
    docsUrl: 'https://www.codebuddy.ai/',
    transport: 'acp-stdio',
    adapterKind: 'acp',
    capabilities: SHARED_AGENT_CAPABILITIES,
    install: {
      packageName: '@tencent-ai/codebuddy-code',
      executableCandidates: ['codebuddy'],
    },
    acp: {
      launchMode: 'codebuddy',
      loginRequired: true,
      modelOptionKey: 'thought_level',
    },
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    shortName: 'OC',
    vendor: 'Anysphere',
    position: '开源开放，灵活接入多种模型',
    badgeColor: '#7c3aed',
    docsUrl: 'https://opencode.ai/docs/',
    transport: 'acp-stdio',
    adapterKind: 'acp',
    capabilities: SHARED_AGENT_CAPABILITIES,
    install: {
      packageName: 'opencode-ai',
      executableCandidates: ['opencode'],
    },
    acp: {
      launchMode: 'opencode',
      loginRequired: false,
      modelOptionKey: 'model',
    },
  },
  zcode: {
    id: 'zcode',
    label: 'ZCode',
    shortName: 'ZC',
    vendor: 'Z.AI',
    position: '本地桌面 AI 编码助手',
    badgeColor: '#0ea5e9',
    docsUrl: 'https://zcode.z.ai/',
    transport: 'zcode-stdio',
    adapterKind: 'zcode',
    capabilities: SHARED_AGENT_CAPABILITIES,
    install: {
      packageName: '',
      executableCandidates: ['resources/glm/zcode.cjs'],
    },
  },
};

export const ENGINE_DEFINITION_LIST = Object.values(ENGINE_DEFINITIONS);
