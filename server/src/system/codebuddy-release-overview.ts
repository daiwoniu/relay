import { releaseTopicIds, type ReleaseOverview, type ReleaseTopicId } from './release-summary.js';

type CodeBuddySection = keyof ReleaseOverview['counts'] | 'other';

const sectionTopicWeights: Record<CodeBuddySection, number> = {
  features: 100,
  improvements: 10,
  fixes: 1,
  documentation: 0,
  chores: 0,
  other: 0,
};

const codeBuddyTopicPatterns: Record<ReleaseTopicId, RegExp> = {
  permissions_security: /(?:安全|权限|审批|沙箱|敏感|凭据|授权|信任|删除|security|permission|approval|sandbox|credential|secret)/i,
  mcp_extensions: /(?:\bMCP\b|扩展|hook)/i,
  plugins_skills: /(?:插件|技能|\bskills?\b|marketplace)/i,
  tasks_sessions: /(?:任务|会话|对话|队列|历史|恢复|回放|草稿|worker|session|task|conversation|queue)/i,
  multi_agent: /(?:多\s*Agent|子\s*Agent|并发\s*Agent|智能体|团队|专家团|agent tree|subagent)/i,
  models_providers: /(?:模型|推理|Provider|本地模型|Bedrock|SDK)/i,
  windows_cross_platform: /(?:Windows|macOS|Linux|跨平台|Unicode|软链|链接路径)/i,
  context_compaction: /(?:上下文|压缩|compact|token|图片预算)/i,
  connection_stability: /(?:连接|断链|重连|无响应|卡死|崩溃|稳定性|弱网|心跳|超时|startup|reconnect|crash)/i,
  terminal_ui: /(?:终端|命令|Web\s*UI|WebUI|界面|输入框|侧栏|文件面板|编辑器|REPL|TUI|terminal)/i,
};

function classifyCodeBuddySection(value: string): CodeBuddySection {
  const heading = value.replace(/[✨🔧🐛📝📦🎉🚀]/gu, '').trim().toLowerCase();
  if (/新功能|功能新增|features?/.test(heading)) return 'features';
  if (/改进|优化|improvements?/.test(heading)) return 'improvements';
  if (/问题修复|修复|bug fixes?|fixed/.test(heading)) return 'fixes';
  if (/文档|documentation/.test(heading)) return 'documentation';
  if (/内部维护|维护项|chores?/.test(heading)) return 'chores';
  return 'other';
}

function createCountRecord(): Record<keyof ReleaseOverview['counts'], { headings: string[]; bullets: string[] }> {
  return {
    features: { headings: [], bullets: [] },
    improvements: { headings: [], bullets: [] },
    fixes: { headings: [], bullets: [] },
    documentation: { headings: [], bullets: [] },
    chores: { headings: [], bullets: [] },
  };
}

export function extractCodeBuddyReleaseOverview(markdown: unknown): ReleaseOverview {
  const counts: ReleaseOverview['counts'] = { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 };
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    return { sourceStatus: 'unrecognized', counts, topics: [] };
  }

  const items = createCountRecord();
  const topicScores = new Map<ReleaseTopicId, number>();
  let section: CodeBuddySection = 'other';
  for (const rawLine of markdown.split(/\r?\n/)) {
    const sectionHeading = /^##\s+(.+?)\s*$/.exec(rawLine);
    if (sectionHeading) {
      section = classifyCodeBuddySection(sectionHeading[1]);
      continue;
    }
    if (section === 'other') continue;
    const itemHeading = /^###\s+(.+?)\s*$/.exec(rawLine);
    const bullet = /^\s*[-*]\s+(?:\*\*)?(.+?)(?:\*\*)?(?:[：:].*)?\s*$/.exec(rawLine);
    if (itemHeading) items[section].headings.push(itemHeading[1].trim());
    if (bullet) items[section].bullets.push(bullet[1].replace(/\*\*/g, '').trim());
    const text = itemHeading?.[1] || bullet?.[1] || rawLine.trim();
    if (!text) continue;
    for (const topic of releaseTopicIds) {
      if (codeBuddyTopicPatterns[topic].test(text)) {
        topicScores.set(topic, (topicScores.get(topic) || 0) + sectionTopicWeights[section]);
      }
    }
  }

  for (const key of Object.keys(items) as Array<keyof typeof items>) {
    counts[key] = items[key].headings.length > 0 ? items[key].headings.length : items[key].bullets.length;
  }
  const itemCount = Object.values(counts).reduce((total, value) => total + value, 0);
  return {
    sourceStatus: itemCount > 0 ? 'available' : 'unrecognized',
    counts,
    topics: releaseTopicIds
      .filter((topic) => topicScores.has(topic))
      .sort((left, right) => (topicScores.get(right) || 0) - (topicScores.get(left) || 0))
      .slice(0, 3),
  };
}
