import type { EngineId } from '../generated/relay-contracts';

export interface EnginePresentation {
  id: EngineId;
  label: string;
  shortName: string;
  vendor: string;
  position: string;
  badgeColor: string;
}

export const ENGINE_PRESENTATIONS: Record<EngineId, EnginePresentation> = {
  codex: { id: 'codex', label: 'Codex', shortName: 'CX', vendor: 'OpenAI', position: '全球前沿的 AI 编程能力', badgeColor: '#111111' },
  codebuddy: { id: 'codebuddy', label: 'CodeBuddy', shortName: 'CB', vendor: '腾讯云', position: '深耕国内开发者生态', badgeColor: '#006bea' },
  opencode: { id: 'opencode', label: 'OpenCode', shortName: 'OC', vendor: 'Anysphere', position: '开源开放，灵活接入多种模型', badgeColor: '#7c3aed' },
  zcode: { id: 'zcode', label: 'ZCode', shortName: 'ZC', vendor: 'Z.AI', position: '本地桌面 AI 编码助手', badgeColor: '#0ea5e9' },
};

export const ENGINE_PRESENTATION_LIST = Object.values(ENGINE_PRESENTATIONS);

export function getEnginePresentation(engine: EngineId): EnginePresentation {
  return ENGINE_PRESENTATIONS[engine];
}

export function engineLabel(engine: EngineId): string {
  return getEnginePresentation(engine).label;
}
