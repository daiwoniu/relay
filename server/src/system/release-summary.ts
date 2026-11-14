export const releaseTopicIds = [
  'permissions_security',
  'mcp_extensions',
  'plugins_skills',
  'tasks_sessions',
  'multi_agent',
  'models_providers',
  'windows_cross_platform',
  'context_compaction',
  'connection_stability',
  'terminal_ui',
] as const;

export type ReleaseTopicId = typeof releaseTopicIds[number];
export type ReleaseOverviewSourceStatus = 'available' | 'metadata_only' | 'unrecognized';

export interface ReleaseOverview {
  sourceStatus: ReleaseOverviewSourceStatus;
  counts: {
    features: number;
    improvements: number;
    fixes: number;
    documentation: number;
    chores: number;
  };
  topics: ReleaseTopicId[];
}

type ReleaseSection = keyof ReleaseOverview['counts'] | 'changelog' | 'other';

const topicPatterns: Record<ReleaseTopicId, RegExp> = {
  permissions_security: /\b(?:permissions?|approvals?|sandbox(?:es)?|guardians?|credentials?|secrets?|trust|deny[- ]read|authoriz\w*|authenticat\w*|oauth|automatic[- ]review|risk scor\w*|sign(?:ed|ing)?|notariz\w*)\b/i,
  mcp_extensions: /\b(?:mcp|extensions?|hooks?)\b/i,
  plugins_skills: /\b(?:plugins?|skills?|marketplaces?)\b/i,
  tasks_sessions: /\b(?:tasks?|sessions?|threads?|conversations?|queue(?:d|s|ing)?|fork(?:ed|s|ing)?|resum(?:e[ds]?|ing)|archiv(?:e[ds]?|ing)|history)\b/i,
  multi_agent: /\b(?:multi[- ]agents?|sub[- ]?agents?|agent roles?|codex agents)\b/i,
  models_providers: /\b(?:models?|reasoning|providers?|bedrock|sdks?|web search)\b/i,
  windows_cross_platform: /\b(?:windows|macos|linux|unix|cross[- ]platform|unicode user path)\b/i,
  context_compaction: /\b(?:contexts?|compaction|compact(?:ed|ing|s)?|token budgets?|retained images?)\b/i,
  connection_stability: /\b(?:connect(?:ed|ing|ions?|s)?|reconnect(?:ed|ing|ions?|s)?|startups?|shutdowns?|hangs?|crash(?:es)?|recover(?:ed|ing|y|ies|s)?|outages?|buffers?)\b/i,
  terminal_ui: /(?:\b(?:tuis?|terminals?|composers?|vim|keybinds?|render(?:ed|ing|s)?|scrollback)\b|\/(?:copy|cd|pwd|cwd)\b)/i,
};

const highImpactSupplementalPattern = /\b(?:permissions?|approvals?|sandbox(?:es)?|credentials?|secrets?|trust|security|sign(?:ed|ing)?|notariz\w*|installers?|updates?|administrators?|enterprise|windows|macos|linux)\b/i;

function classifySection(value: string): ReleaseSection {
  const heading = value.trim().toLowerCase();
  if (/feature|added|新增|功能/.test(heading)) return 'features';
  if (/bug fix|fixed|修复/.test(heading)) return 'fixes';
  if (/documentation|文档/.test(heading)) return 'documentation';
  if (/chore|maintenance|维护/.test(heading)) return 'chores';
  if (/changelog|完整变更/.test(heading)) return 'changelog';
  return 'other';
}

export function extractReleaseOverview(markdown: unknown): ReleaseOverview {
  const counts: ReleaseOverview['counts'] = { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 };
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    return { sourceStatus: 'unrecognized', counts, topics: [] };
  }

  let section: ReleaseSection = 'other';
  let hasChangelog = /full changelog\s*:/i.test(markdown);
  const topicHits = new Set<ReleaseTopicId>();
  for (const rawLine of markdown.split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(rawLine);
    if (heading) {
      section = classifySection(heading[1]);
      if (section === 'changelog') hasChangelog = true;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(rawLine);
    if (!bullet || !['features', 'fixes', 'documentation', 'chores'].includes(section)) continue;
    counts[section as keyof ReleaseOverview['counts']] += 1;
    if ((section === 'documentation' || section === 'chores') && !highImpactSupplementalPattern.test(bullet[1])) continue;
    for (const topic of releaseTopicIds) {
      if (topicPatterns[topic].test(bullet[1])) topicHits.add(topic);
    }
  }

  const itemCount = Object.values(counts).reduce((total, value) => total + value, 0);
  return {
    sourceStatus: itemCount > 0 ? 'available' : hasChangelog ? 'metadata_only' : 'unrecognized',
    counts,
    topics: releaseTopicIds.filter((topic) => topicHits.has(topic)).slice(0, 3),
  };
}
