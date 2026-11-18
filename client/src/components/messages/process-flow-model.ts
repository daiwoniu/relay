import type { ProcessStep, ProcessTimelineEntry } from '../../stores/chat';
import type { MessageOutcome, MessageAttachmentDto, MessageAttachmentSummaryDto } from '../../generated/relay-contracts';
import type { MessageVisualState } from './message-status';
import { describeCommandInvocation, describeCommandTarget, describeReadRange, describeReadCommands } from './process-flow-command.ts';
import { describeWebOperation, describeFileChanges } from '../../stores/process-event-summary.ts';
import { getReasoningDisplayText, getProcessCommand, hasVisibleProcessStep } from '../../stores/process-step-visibility.ts';
import { getFlowTimes } from './process-flow-time.ts';
import { getProcessStepStatus } from './process-step-status.ts';
import { getProcessNarrativeStatus, type ProcessNarrativeStatus } from './process-timeline.ts';
import { getSubAgentActivityLabel, getSubAgentActivityStepInfo } from './sub-agent-activity.ts';

export interface FlowRuntimeStatus { state: MessageVisualState; label: string }

export type FlowCategory = 'input' | 'assistant' | 'planning' | 'reading' | 'execution' | 'generation' | 'collaboration' | 'interaction' | 'system' | 'tooling' | 'other';
export type FlowState = 'running' | 'completed' | 'failed' | 'waiting' | 'stopped' | 'unknown';
export type ProcessView = 'list' | 'time' | 'category';
export type FlowGrouping = 'action' | 'tool' | 'resource';
export const FLOW_CATEGORIES: Record<FlowCategory, string> = {
  input: '用户输入', assistant: '助手消息', planning: '分析与计划', reading: '读取与检索',
  execution: '执行与变更', generation: '内容生成', collaboration: '协作与委派',
  interaction: '提问与授权', system: '运行状态', tooling: '其他工具操作', other: '未识别事件',
};
const FLOW_SOURCE_LABELS: Record<string, string> = {
  '终端': '终端', 'Git · 终端': '终端', '内置工具': '内置工具',
  '系统': '引擎', 'Codex': '引擎', '文件操作': '引擎',
  '用户': '用户消息', '助手': '助手消息', '子代理': '引擎',
  '信任规则': '引擎', '人机交互': '引擎', 'MCP 交互': 'MCP 工具（来源未记录）', 'Hook': '引擎', '图片查看': '图片工具',
  '服务未提供 · MCP': 'MCP 工具（来源未记录）', '网络搜索': '网页工具',
};
export const getFlowSourceLabel = (source: string): string => FLOW_SOURCE_LABELS[source] || source;
export const FLOW_STATES: Record<FlowState, string> = {
  running: '进行中', completed: '已完成', failed: '失败', waiting: '等待处理', stopped: '已停止', unknown: '结果未确认',
};
export interface FlowInput {
  kind?: 'initial' | 'supplement' | 'answer';
  recordedAt?: number;
  id: string;
  content: string;
  delivery: string;
  state: FlowState;
  afterItemId?: string;
  positionKnown: boolean;
  attachments?: (MessageAttachmentDto | MessageAttachmentSummaryDto)[];
}
export interface FlowUiState { expanded: Record<string, boolean>; details: Record<string, boolean>; panelExpanded?: boolean; panelSettled?: boolean; selectedNodeId?: string; grouping?: FlowGrouping; categoryOpen?: Partial<Record<FlowGrouping, string>>; view?: ProcessView }
export interface ProcessFlowContext {
  readOnly?: boolean;
  canReadSubAgentReports?: boolean;
  id: string;
  sessionId: string;
  turnId: string;
  root: FlowInput;
  inputs: FlowInput[];
  ui: FlowUiState;
  steps: ProcessStep[];
  timeline: ProcessTimelineEntry[];
  projectPath?: string;
  projectName?: string;
  knownProjects?: { name: string; path: string }[];
}
export interface FlowNode {
  executionCwd?: string;
  contextProject?: { id: string; label: string };
  recordedAt?: number;
  id: string;
  category: FlowCategory;
  title: string;
  subtitle: string;
  hint?: string;
  source: string;
  state: FlowState;
  statusLabel?: string;
  text?: string;
  step?: ProcessStep;
  sequence: number;
  positionKnown?: boolean;
  children?: FlowNode[];
  resource?: { id: string; label: string; name?: string; count?: number; group?: { id: string; label: string } };
  attachments?: FlowInput['attachments'];
}
export interface FlowGroup { id: string; title: string; appearance?: string; owner?: boolean; nodes: FlowNode[] }
export interface FlowCapability { family: string; title: string; id: string; label: string; detail?: string; section: string; unit: string; owner?: { id: string; label: string } }
export interface FlowCapabilityBucket { id: string; family: string; label: string; detail?: string; summary?: string; section: string; unit: string; nodes: FlowNode[] }

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const firstString = (...values: unknown[]): string => values.map(string).find(Boolean) || '';
const clip = (value: string, length = 100) => value.length > length ? `${value.slice(0, length)}…` : value;
const normalize = (value: string) => value.replace(/\\/g, '/').replace(/([^/])\/+/g, '$1/').replace(/\/$/, '');
const pathKey = (value: string) => /^(?:[a-z]:|\/\/)/i.test(value) ? normalize(value).toLowerCase() : normalize(value);
const fileName = (value: string) => normalize(value).split('/').filter(Boolean).pop() || value;
const isWithin = (path: string, root: string) => pathKey(path).startsWith(`${pathKey(root)}/`);
const isRulePath = (path: string) => /(?:^|[\\/])(?:AGENTS|WORKBUDDY|CLAUDE)\.md$|(?:^|[\\/])(?:rules|standards)[\\/].*\.md$/i.test(path);

type ResourceContext = Pick<ProcessFlowContext, 'projectName' | 'projectPath' | 'knownProjects'> & { cwd?: string };
function matchingProject(path: string, context: ResourceContext) {
  return context.knownProjects?.filter(project => pathKey(path) === pathKey(project.path) || isWithin(path, project.path))
    .sort((a, b) => normalize(b.path).length - normalize(a.path).length)[0];
}
function resolveResourcePath(path: string, context: ResourceContext): string {
  const root = normalize(context.projectPath || '');
  const raw = normalize(path);
  const absolute = /^(?:[a-z]:\/|\/)/i.test(raw);
  const cwd = normalize(context.cwd || '');
  const base = cwd && root && !/^(?:[a-z]:\/|\/)/i.test(cwd) ? `${root}/${cwd}` : cwd || root;
  const joined = !absolute && base ? `${base}/${raw}` : raw;
  const parts: string[] = [];
  for (const part of joined.split('/')) { if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (part !== '.') parts.push(part); }
  return parts.join('/');
}
function resourceInfo(path: string, context: ResourceContext, directory = false): NonNullable<FlowNode['resource']> {
  if (/^[a-z][\w+.-]+:\/\//i.test(path)) return { id: 'uri', label: '链接资源', group: { id: 'links', label: '链接资源' } };
  const root = normalize(context.projectPath || '');
  const clean = resolveResourcePath(path, context);
  const project = context.projectName || fileName(root) || '当前项目';
  const worktreeRoot = clean.match(/^(.*)\/\.worktrees\/[^/]+(?:\/|$)/)?.[1];
  const known = matchingProject(clean, context) || (worktreeRoot ? { path: worktreeRoot, name: fileName(worktreeRoot) } : undefined);
  const label = known ? `${known.name}${root && pathKey(known.path) !== pathKey(root) ? known.path === worktreeRoot ? '（外部工作树目录）' : '（外部项目）' : ''} · ${fileName(clean)}`
    : root && (isWithin(clean, root) || clean.toLowerCase() === root.toLowerCase()) || !/^(?:[a-z]:\/|\/)/i.test(clean) ? `${project} · ${fileName(clean)}` : `外部文件 · ${fileName(clean)}`;
  const projectRoot = known?.path || (root && (isWithin(clean, root) || pathKey(clean) === pathKey(root)) ? root : '');
  const cwd = context.cwd ? resolveResourcePath(context.cwd, { ...context, cwd: undefined }) : '';
  const directoryRoot = directory ? clean : cwd && (isWithin(clean, cwd) || pathKey(clean) === pathKey(cwd)) ? cwd : '';
  const group = projectRoot ? { id: `project:${pathKey(projectRoot)}`, label: known?.name || project }
    : directoryRoot ? { id: `directory:${pathKey(directoryRoot)}`, label: `目录 · ${fileName(directoryRoot)}` }
    : { id: 'external', label: '未匹配项目的文件' };
  return { id: `path:${pathKey(clean)}`, label, name: fileName(clean), count: 1, group };
}
function flowProject(context: ResourceContext, cwd = '') {
  return cwd ? resourceInfo(cwd, context, true).group : context.projectPath ? { id: `project:${pathKey(context.projectPath)}`, label: context.projectName || fileName(context.projectPath) } : undefined;
}
function fileIdentity(path: string, context: ResourceContext): string {
  const resolved = resolveResourcePath(path, context), root = normalize(context.projectPath || '');
  return root && isWithin(resolved, root) ? resolved.slice(root.length + 1) : /^(?:[a-z]:\/|\/)/i.test(resolved) ? fileName(resolved) : normalize(path);
}
function foreignContext(resource: FlowNode['resource'], context: ResourceContext): string | undefined {
  const group = resource?.group;
  if (!group) return undefined;
  if (group.id.startsWith('project:')) return group.id !== `project:${pathKey(context.projectPath || '')}` ? `项目：${group.label}` : undefined;
  return group.id.startsWith('directory:') ? group.label : group.id === 'external' ? '外部文件' : undefined;
}
const detailLine = (...parts: (string | undefined)[]) => [...new Set(parts.filter((value): value is string => Boolean(value)))].join(' · ') || undefined;
const namesSummary = (paths: string[]) => paths.slice(0, 2).map(fileName).join('、') + (paths.length > 2 ? ` 等 ${paths.length} 项` : '');
const otherFiles = (paths: string[]) => paths.length > 1 ? `另含：${namesSummary(paths.slice(1))}` : undefined;
function resources(paths: string[], context: ResourceContext): FlowNode['resource'] {
  const entries = [...new Map(paths.map((path, index) => { const entry = resourceInfo(path, context); return [entry.id === 'uri' ? `uri:${index}` : entry.id, entry] as const; })).values()];
  const groups = [...new Map(entries.map(entry => [entry.group!.id, entry.group!])).values()];
  return entries.length > 1 ? { id: entries.some(entry => entry.id === 'uri') ? 'multiple' : `multiple:${JSON.stringify(entries.map(entry => entry.id).sort())}`, count: entries.length, label: '多文件操作', group: groups.length === 1 ? groups[0] : { id: 'cross', label: groups.every(group => group.id.startsWith('project:')) ? '跨项目操作' : '跨资源操作' } } : entries[0];
}

function readInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.length < 100_000) {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch { /* Opaque tool input. */ }
  }
  return {};
}

function skillInfo(command: string, context: ResourceContext) {
  const targets = describeReadCommands(command).flatMap(part => describeCommandTarget(part).paths).filter(path => /(?:^|[\\/])SKILL\.md$/i.test(path) && !/[$`]/.test(path));
  if (new Set(targets.map(path => pathKey(resolveResourcePath(path, context)).replace(/\/skill\.md$/i, ''))).size > 1) return null;
  const target = targets[0];
  if (!target) return null;
  const path = resolveResourcePath(target, context);
  const parts = path.split('/');
  const name = parts[parts.length - 2] || '未命名技能';
  const source = /\/(?:plugins|plugin-cache)\//i.test(path) ? '插件技能'
    : /\/\.system\//i.test(path) ? '系统技能'
      : matchingProject(path, context) || context.projectPath && isWithin(path, context.projectPath) || /\/(?:doc\/)?ai\/skills\//i.test(path) ? '工作区技能'
        : /\/(?:\.agents|\.codex)\/skills\//i.test(path) ? '个人技能' : '外部技能文件';
  return { name, source, path };
}

function commandInfo(command: string, context: ResourceContext, remote = false) {
  const node = describeCommand(command, context);
  const resource = node.resource || resourceInfo(context.cwd || context.projectPath || '.', context, true);
  return { ...node, hint: detailLine(node.hint, remote ? undefined : foreignContext(resource, context)), resource };
}
function describeCommand(command: string, context: ResourceContext): Pick<FlowNode, 'category' | 'title' | 'subtitle' | 'source' | 'hint' | 'resource'> {
  const invocation = describeCommandInvocation(command);
  const execution = () => ({ category: 'execution' as const,
    title: invocation.inline ? '执行代码' : invocation.module ? '运行模块' : invocation.script ? invocation.check ? '检查脚本语法' : '运行脚本' : '执行命令',
    subtitle: invocation.inline || invocation.module || (invocation.script ? fileIdentity(invocation.script, context) : invocation.label || '命令身份未记录'),
    hint: invocation.script || invocation.module ? invocation.label === '脚本文件' ? undefined : invocation.label : invocation.label === '变量赋值' ? invocation.label : undefined,
    source: '终端', resource: invocation.script ? resourceInfo(invocation.script, context) : undefined });
  if (command.length > 4096) return execution();
  const skill = !invocation.script && !/^git(?:\.exe|\.cmd)?\s/i.test(invocation.label || '') ? skillInfo(command, context) : null;
  if (skill) { const resource = resourceInfo(skill.path, context); return { category: 'reading' as const, title: '读取技能', subtitle: skill.name, hint: detailLine('SKILL.md', describeReadRange(command), skill.source), source: '终端', resource: { ...resource, label: `技能：${skill.name}`, group: skill.source === '工作区技能' ? resource.group : { id: `skill:${skill.source}`, label: skill.source } } }; }
  const reads = describeReadCommands(command).flatMap(part => describeCommandTarget(part).paths);
  if (reads.length && reads.every(isRulePath) && !invocation.script && !/^git(?:\.exe|\.cmd)?\s/i.test(invocation.label || '')) return { category: 'reading', title: '读取规则', subtitle: namesSummary(reads), hint: describeReadRange(command), source: '终端', resource: resources(reads, context) };
  const paths = [...command.matchAll(/(?:"([^"]+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|py|ya?ml|toml|java))"|'([^']+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|py|ya?ml|toml|java))'|([^\s"'<>]+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|py|ya?ml|toml|java)))/gi)];
  const targets = paths.map(match => match[1] || match[2] || match[3]);
  const target = targets[targets.length - 1];
  const simple = command.trim().replace(/^rtk\s+err\s+/i, '');
  if (/^(?:rg\s|rtk\s+(?:rg|grep)\s|node\s+\S*search\.mjs\b|Select-String\b)/i.test(simple)) {
    const search = describeCommandTarget(simple);
    const hint = search.paths.length ? `范围：${clip(search.paths.map(fileName).join('、'), 60)}` : undefined;
    const resource = resources(search.paths, context);
    return { category: 'reading' as const, title: '搜索内容', subtitle: search.query ? clip(search.query) : /--files\b/.test(simple) ? '文件列表' : '搜索条件未记录', hint, source: '终端', resource };
  }
  if (/^(?:Get-Content\b|gc\s|type\s|cat\s|rtk\s+read\s)/i.test(simple)) {
    const files = reads;
    const resource = files.length ? `${fileIdentity(files[0], context)}${files.length > 1 ? ` 等 ${files.length} 个文件` : ''}` : target ? fileIdentity(target, context) : '文件未记录';
    const hint = describeReadRange(simple);
    return { category: 'reading' as const, title: '查看文件', subtitle: resource, hint, source: '终端', resource: resources(files, context) };
  }
  if (/^(?:node\s+(?:--\S+\s+)*--test\b|(?:npx(?:\.cmd)?\s+)?tsx\s+--test\b|npm(?:\.cmd)?\s+(?:run\s+)?test\b|pytest\b|(?:npx(?:\.cmd)?\s+)?vitest\b|rtk\s+test\b)/i.test(simple)) return { category: 'execution' as const, title: '运行测试', subtitle: invocation.label || '测试命令', hint: invocation.script ? fileIdentity(invocation.script, context) : undefined, source: '终端', resource: invocation.script ? resourceInfo(invocation.script, context) : undefined };
  if (/^(?:(?:npx(?:\.cmd)?\s+)?tsc\b|npm(?:\.cmd)?\s+run\s+(?:typecheck|check-types)\b)/i.test(simple)) return { category: 'execution' as const, title: '检查代码类型', subtitle: invocation.label || '类型检查命令', source: '终端' };
  if (/^(?:npm(?:\.cmd)?\s+run\s+build\b|(?:npx(?:\.cmd)?\s+)?vite\s+build\b)/i.test(simple)) return { category: 'execution' as const, title: '构建项目', subtitle: invocation.label || '构建命令', source: '终端' };
  const git = invocation.label?.match(/^git(?:\.exe|\.cmd)?\s+(status|diff|log|show|add|commit|push|pull|fetch|switch|merge)\b/i);
  if (git) return { category: /^(status|diff|log|show)$/i.test(git[1]) ? 'reading' : 'execution', title: ({ status: '查看状态', diff: '检查差异', log: '查看历史', show: '查看提交', add: '暂存文件', commit: '提交代码', push: '推送代码', pull: '拉取代码', fetch: '获取更新', switch: '切换分支', merge: '合并代码' } as Record<string, string>)[git[1].toLowerCase()], subtitle: invocation.label || `git ${git[1]}`, source: 'Git · 终端' };
  return execution();
}

export function getFlowStepState(step: ProcessStep, outcome?: MessageOutcome): FlowState {
  const d = step.details;
  const status = getProcessStepStatus(step);
  if (status === 'incomplete') return 'failed';
  if (step.type === 'interaction' && d.resolvedAction) return ['decline', 'cancel'].includes(String(d.resolvedAction)) ? 'stopped' : ['accept', 'accept_for_session', 'submit', 'submitted', 'resolved_elsewhere'].includes(String(d.resolvedAction)) ? 'completed' : 'unknown';
  if (step.type === 'interaction' && status === 'in_progress') return d.interactionKind === 'async_question' ? 'waiting' : outcome ? outcome === 'stopped' ? 'stopped' : 'unknown' : 'waiting';
  if (status === 'in_progress') return outcome ? outcome === 'stopped' ? 'stopped' : 'unknown' : 'running';
  return status === 'completed' ? 'completed' : 'unknown';
}

export function getFlowStatusLabel(node: FlowNode): string {
  if (node.state === 'failed') return FLOW_STATES.failed;
  if (node.statusLabel) return node.statusLabel;
  if (node.step?.type === 'subAgentActivity') return getSubAgentActivityLabel(node.step.details);
  if (node.step?.type === 'plan' && node.state === 'completed') return '已记录';
  if (node.step?.type === 'interaction') {
    const d = node.step.details;
    const question = ['async_question', 'user_input'].includes(String(d.interactionKind));
    if (node.state === 'waiting') return question ? '待回答' : '待授权';
    const labels: Record<string, string> = { decline: '已拒绝', cancel: '已取消', accept: '已允许', accept_for_session: '已允许', resolved_elsewhere: '已处理', submit: question ? '已回答' : '已提交', submitted: question ? '已回答' : '已提交' };
    if (labels[String(d.resolvedAction)]) return labels[String(d.resolvedAction)];
  }
  return FLOW_STATES[node.state];
}

const stepPresentations = new WeakMap<ProcessStep, { key: string; projects: ResourceContext['knownProjects']; node: FlowNode }>();
export function presentFlowStep(step: ProcessStep, context: ResourceContext, outcome?: MessageOutcome): FlowNode {
  const key = `${context.projectPath || ''}\n${context.projectName || ''}\n${outcome || ''}`;
  const cached = stepPresentations.get(step);
  if (cached?.key === key && cached.projects === context.knownProjects) return cached.node;
  const node = describeFlowStep(step, context, outcome);
  const args = readInput(step.details.arguments || step.details.input || step.details.params);
  const localFiles = !/MCP/.test(node.source) && (step.type === 'fileChange' || ['查看文件', '编辑文件', '登记文件变更', '读取技能', '读取规则', '查看图片'].includes(node.title));
  const cwd = localFiles || /^(?:终端|Git · 终端)$/.test(node.source) ? firstString(step.details.cwd, args.workdir, args.cwd) : '';
  if (cwd) node.executionCwd = resolveResourcePath(cwd, { ...context, cwd: undefined });
  node.contextProject = flowProject(context, node.executionCwd);
  const name = firstString(step.details.tool, step.details.toolName, step.details.name);
  if (step.type === 'mcpToolCall' || step.type === 'dynamicToolCall' && /^mcp[_.]/i.test(name)) {
    const parts = name.split('__');
    const tool = parts[0] === 'mcp' && parts.length >= 3 ? parts.slice(2).join('__') : name;
    if (tool) {
      const object = node.subtitle === tool ? undefined : node.subtitle.startsWith(`${tool} · `) ? node.subtitle.slice(tool.length + 3) : node.subtitle;
      node.hint = detailLine(object, node.hint);
      node.subtitle = tool;
    }
    // A remote command's cwd/path does not establish a local project association.
    if (node.resource && !/^(?:database:|remote-files:|links$)/.test(node.resource.group?.id || '')) {
      const server = firstString(step.details.server, step.details.serverName) || (parts[0] === 'mcp' && parts.length >= 3 ? parts[1] : '');
      node.resource = { ...node.resource, group: { id: `remote-files:${server || 'missing'}`, label: `远程文件 · ${server || '来源未记录'}` } };
    }
  }
  stepPresentations.set(step, { key, projects: context.knownProjects, node });
  return node;
}
function describeFlowStep(step: ProcessStep, context: ResourceContext, outcome?: MessageOutcome): FlowNode {
  const d = step.details;
  const node: FlowNode = { id: step.id, category: 'other', title: '未识别的执行事件', subtitle: clip(step.type), source: 'Codex', state: getFlowStepState(step, outcome), step, sequence: 0 };
  switch (step.type) {
    case 'userMessage':
    case 'agentMessage': {
      const user = step.type === 'userMessage';
      const text = getReasoningDisplayText(d);
      return { ...node, category: user ? 'input' : 'assistant', title: user ? '输入记录' : '说明进度', subtitle: clip(text) || '附件或非文本消息，展开查看记录', text, source: user ? '用户' : '助手' };
    }
    case 'imageView': {
      const path = firstString(d.path, d.filePath);
      const imageContext = { ...context, cwd: string(d.cwd) };
      const resource = path ? resourceInfo(path, imageContext) : undefined;
      return { ...node, category: 'reading', title: '查看图片', subtitle: path ? fileIdentity(path, imageContext) : '图片未记录', hint: foreignContext(resource, imageContext), source: '图片查看', resource };
    }
    case 'hookPrompt': {
      const name = firstString(d.name, d.title), body = clip(getReasoningDisplayText(d));
      return { ...node, category: 'system', title: '显示提示', subtitle: name || body, hint: name && body && name !== body ? body : undefined, source: 'Hook' };
    }
    case 'sleep': return { ...node, category: 'system', title: '引擎等待', subtitle: '引擎报告的等待事件', source: '系统' };
    case 'enteredReviewMode':
    case 'exitedReviewMode': return { ...node, category: 'planning', title: step.type === 'enteredReviewMode' ? '进入审查模式' : '退出审查模式', subtitle: clip(getReasoningDisplayText(d)) || '查看审查记录', source: 'Codex' };
    case 'commandExecution': {
      return { ...node, ...commandInfo(getProcessCommand(d), { ...context, cwd: string(d.cwd) }) };
    }
    case 'reasoning': return { ...node, category: 'planning', title: '分析执行思路', subtitle: clip(getReasoningDisplayText(d)) || '引擎未提供可展示摘要' };
    case 'plan': return { ...node, category: 'planning', state: node.state === 'failed' ? 'failed' : 'completed', title: '更新执行计划', subtitle: clip(string(d.explanation)) || '最新进度见底部', hint: Array.isArray(d.plan) && d.plan.length ? `已完成 ${d.plan.filter(item => item?.status === 'completed').length}/${d.plan.length} 项 · ${d.plan.filter(item => item?.status === 'in_progress').length} 项进行中` : undefined };
    case 'fileChange': {
      const fileContext = { ...context, cwd: string(d.cwd) };
      const { paths, action, counts } = describeFileChanges(d);
      const resource = resources(paths, fileContext);
      return { ...node, category: 'execution', title: `${action}文件`, subtitle: paths.length ? `${fileIdentity(paths[0], fileContext)}${paths.length > 1 ? ` 等 ${paths.length} 个文件` : ''}` : '文件未记录', hint: detailLine(counts, otherFiles(paths), foreignContext(resource, fileContext)), source: '文件操作', resource };
    }
    case 'webSearch': {
      const web = describeWebOperation(d);
      return { ...node, category: 'reading', ...web, subtitle: clip(web.subtitle), hint: web.hint ? clip(web.hint) : undefined, source: '网络搜索' };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const name = firstString(d.tool, d.toolName, d.name);
      const input = readInput(d.arguments || d.input || d.params);
      const inputPath = firstString(input.path, input.filePath, input.file_path, input.filename);
      const mcp = step.type === 'mcpToolCall' || /^mcp[_.]/i.test(name);
      const toolContext = { ...(mcp ? {} : context), cwd: firstString(d.cwd, input.workdir, input.cwd) };
      const nameParts = name.split('__');
      const qualified = nameParts[0] === 'mcp' && nameParts.length >= 3;
      const server = firstString(d.server, d.serverName) || (qualified ? nameParts[1] : '');
      const tool = (qualified ? nameParts.slice(2).join('__') : name) || '未命名工具';
      const source = mcp ? `${server || '服务未提供'} · MCP` : '内置工具';
      if (inputPath) {
        const resource = resourceInfo(inputPath, toolContext);
        node.resource = mcp ? { ...resource, label: resource.id === 'uri' ? 'MCP 资源' : fileName(inputPath), group: resource.id === 'uri' ? resource.group : { id: `remote-files:${server || 'missing'}`, label: `远程文件 · ${server || '来源未记录'}` } } : resource;
      }
      const database = firstString(input.db_name, input.database_name, input.target_db_name);
      if (!node.resource && database) node.resource = { id: `database:${server}:${database}`, label: database, group: { id: `database:${server}:${database}`, label: `数据库 · ${database}${server ? `（${server}）` : ''}` } };
      const known: Record<string, [FlowCategory, string]> = {
        'ddl_request.submit': ['execution', '提交 DDL 工单'], 'ddl_request.detail': ['reading', '查看 DDL 工单'], 'ddl_request.list': ['reading', '查询 DDL 工单'],
        'meta_data.search': ['reading', '搜索元数据'], 'meta_data.instance_capacity': ['reading', '查看实例容量'],
        'structure_standard.evaluate_ddl': ['execution', '校验 DDL 规范'], 'structure_standard.rules': ['reading', '读取结构规范'],
        'meta_data.detail': ['reading', '查看元数据详情'],
        'data_asset.discovery': ['reading', '查找数据表及资产'], 'data_asset.relationships': ['reading', '查看资产依赖'],
        'data_asset.detail': ['reading', '查看数据资产'], 'data_asset.impact_analysis': ['reading', '分析资产影响范围'],
        'data_monitor.metric_list': ['reading', '查看监控指标'], 'data_standard.detail': ['reading', '查看数据标准'],
        'tax_workbench.precheck_result': ['reading', '查看任务与预检结果'], 'tax_workbench.source': ['reading', '查看任务附件来源'],
        'tax_workbench.manual_upload': ['execution', '上传任务附件'],
        'table_analysis.status': ['reading', '查看分析任务状态'], 'table_analysis.context': ['reading', '读取分析任务上下文'],
        'table_analysis.start': ['execution', '启动数据分析任务'], 'table_analysis.test': ['execution', '测试分析脚本'],
        'static_report.status': ['reading', '查看静态报告状态'],
      };
      const friendly = known[tool];
      const query = firstString(input.keyword, input.searchQuery, input.pattern, /search|list|discovery/i.test(tool) ? input.query : '');
      const scalar = (...values: unknown[]) => values.find(value => typeof value === 'string' && value.trim() || typeof value === 'number' && Number.isFinite(value));
      const target = [['数据库', scalar(input.db_name, input.database_name, input.target_db_name)], ['实例', scalar(input.database_instance_id, input.target_db_inst)], ['表', input.table_name], ['表ID', scalar(input.table_metadata_id, input.table_asset_id)], ['任务ID', scalar(input.task_id, input.run_id)], ['请求ID', input.request_id]].flatMap(([label, value]) => typeof value === 'string' && value.trim() || typeof value === 'number' && Number.isFinite(value) ? [`${label}：${clip(String(value), 40)}`] : []).join(' · ') || node.resource?.label;
      const limits = [['上限', input.limit], ['深度', input.depth], ['页大小', input.page_size]].flatMap(([label, value]) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? [`${label} ${value}`] : []);
      node.hint = detailLine(target, query ? `关键词：${clip(query, 40)}` : undefined, ...limits);
      const toolSubtitle = tool;
      if (mcp && friendly) return { ...node, category: friendly[0], title: friendly[1], subtitle: toolSubtitle, source };
      if (tool === 'relay_report_file_changes') {
        const files = Array.isArray(d.fileChanges) ? d.fileChanges : Array.isArray(input.reportedFileChanges) ? input.reportedFileChanges : [];
        const paths = [...new Set(files.map(value => string(value?.path)).filter(Boolean))];
        return { ...node, category: 'execution', title: '登记文件变更', subtitle: paths.length ? `${fileIdentity(paths[0], toolContext)}${paths.length > 1 ? ` 等 ${paths.length} 个文件` : ''}` : '变更文件清单', hint: otherFiles(paths), source, resource: resources(paths, toolContext) };
      }
      const verb = tool.split('.').pop() || tool;
      if (!mcp && d.readOnlyHint !== false && /^(?:read|read_file|read_text_file|get_file)$/i.test(verb) && inputPath) return { ...node, category: 'reading', title: '查看文件', subtitle: fileIdentity(inputPath, toolContext), source };
      if (/^(?:apply_patch|edit_file|write_file|write|edit)$/i.test(verb)) return { ...node, category: 'execution', title: '编辑文件', subtitle: inputPath ? mcp ? fileName(inputPath) : fileIdentity(inputPath, toolContext) : tool, source };
      if (/^(?:exec_command|shell|terminal)$/.test(verb) && string(input.cmd || input.command)) return { ...node, ...commandInfo(string(input.cmd || input.command), toolContext, mcp), source: mcp ? source : '终端' };
      if (/^(?:imagegen|image_generate|generate_image)$/.test(verb)) return { ...node, category: 'generation', title: '生成图片', subtitle: tool, source };
      if (tool === 'get_design_context') return { ...node, category: 'reading', title: '读取设计稿', subtitle: string(input.nodeId) ? `设计节点 ${string(input.nodeId)}` : tool, source };
      const mutation = /(?:^|_)(?:create|update|delete|write|set|submit|execute|run)(?:_|$)|(?:Create|Update|Delete|Write|Set|Submit|Execute|Run)(?:[A-Z]|$)/.test(verb);
      if (d.readOnlyHint !== false && !mutation && /^(?:read|fetch|get|search|list|view)(?:_|$|[A-Z])/.test(verb)) return { ...node, category: 'reading', title: /^search/.test(verb) ? '检索工具资料' : /^list/.test(verb) ? '列出工具资源' : '读取工具内容', subtitle: toolSubtitle, source };
      return { ...node, category: d.readOnlyHint === true ? 'reading' : 'tooling', title: '调用工具', subtitle: toolSubtitle, hint: node.hint || (d.readOnlyHint === true ? '只读调用（工具声明）' : undefined), source };
    }
    case 'imageGeneration': return { ...node, category: 'generation', title: '生成图片', subtitle: clip(string(d.prompt)) || '查看生成记录', source: '图片工具' };
    case 'collabAgentToolCall':
    case 'subAgentActivity': {
      const results = Array.isArray(d.agentResults) ? d.agentResults : [];
      const children: FlowNode[] = results.filter(value => value && typeof value.threadId === 'string').map((value, index) => ({
        id: `${step.id}:agent:${value.threadId}`, category: 'collaboration', title: '执行子任务',
        subtitle: string(value.name) || `子任务 ${index + 1}`, hint: clip(string(value.message)) || undefined, source: '子代理', sequence: 0,
        state: value.status === 'completed' ? 'completed' : value.status === 'errored' ? 'failed' : ['shutdown', 'interrupted'].includes(value.status) ? 'stopped' : !outcome && ['running', 'pendingInit'].includes(value.status) ? 'running' : 'unknown',
        text: string(value.message) || undefined,
      }));
      const actions: Record<string, string> = { spawnAgent: '创建子任务', sendInput: '发送子任务消息', resumeAgent: '恢复子任务', wait: '等待子任务', closeAgent: '关闭子任务' };
      const states: Partial<Record<FlowState, string>> = { running: '进行中', completed: '已完成', failed: '失败', stopped: '已停止', unknown: '结果未确认' };
      const summary = Object.entries(states).flatMap(([state, label]) => { const count = children.filter(child => child.state === state).length; return count ? [`${count} ${label}`] : []; });
      const activity = step.type === 'subAgentActivity' ? getSubAgentActivityStepInfo(d) : undefined;
      return { ...node, category: 'collaboration', title: activity ? '子任务活动' : actions[string(d.tool)] || '执行子任务', subtitle: activity?.title || firstString(d.agentName, d.name) || clip(firstString(d.prompt, d.content)) || '子任务信息未记录', hint: detailLine(children.length ? `${children.length} 个子任务` : undefined, summary.join(' · ')), source: '子代理', children };
    }
    case 'interaction': {
      const kind = string(d.interactionKind);
      const automatic = /trust/.test(string(d.decisionSource));
      const question = Array.isArray(d.questions) ? d.questions[0] : undefined;
      const isQuestion = kind === 'async_question' || kind === 'user_input';
      const invocation = describeCommandInvocation(getProcessCommand(d));
      const commandIdentity = invocation.inline ? `${invocation.inline} 代码` : invocation.script ? `${invocation.label} ${fileIdentity(invocation.script, { ...context, cwd: string(d.cwd) })}` : invocation.label;
      const subtitle = isQuestion ? clip(firstString(question?.title, d.title)) || '问题内容未记录' : commandIdentity || clip(firstString(d.title, d.method)) || '授权内容未记录';
      const size = Array.isArray(d.questions) && d.questions.length ? `${d.questions.length} 个问题${Array.isArray(question?.options) && question.options.length ? ` · 首题 ${question.options.length} 个选项` : ''}` : string(d.grantRoot) && !subtitle.includes(string(d.grantRoot)) ? `授权目录：${fileName(string(d.grantRoot))}` : undefined;
      const reason = clip(string(d.reason));
      const hint = detailLine(size, reason && reason !== subtitle ? reason : undefined, automatic ? d.decisionSource === 'project_trust' ? '决策：项目规则' : '决策：会话规则' : undefined);
      return { ...node, category: 'interaction', title: isQuestion ? '请求回答' : '请求授权', subtitle, hint, source: string(d.serverName) ? `${string(d.serverName)} · MCP` : '系统' };
    }
    case 'contextCompaction': return { ...node, category: 'system', title: '整理会话上下文', subtitle: '整理较早内容，为后续处理保留上下文', source: '系统' };
    case 'systemNotice': {
      const kinds: Record<string, string> = { model_rerouted: '模型切换', warning: '运行提示', guardian_warning: '安全提示', config_warning: '配置提示', deprecation: '弃用提示', context_compaction: '整理会话上下文' };
      const modelChange = d.noticeType === 'model_rerouted' && string(d.toModel);
      const subtitle = clip(modelChange ? string(d.toModel) : string(d.title) || string(d.message));
      const detail = clip(modelChange && string(d.fromModel) ? `原模型：${string(d.fromModel)}` : string(d.message));
      return { ...node, category: 'system', title: d.kind === 'engine_retry' ? '连接重试' : kinds[string(d.noticeType)] || '系统提示', subtitle, hint: detail && detail !== subtitle ? detail : undefined, source: '系统' };
    }
    default: return node;
  }
}

export function buildFlowNodes(context: ProcessFlowContext, steps: ProcessStep[], timeline: ProcessTimelineEntry[], options: { outcome?: MessageOutcome; finalContent?: string; finalRecordedAt?: number; streaming?: boolean; narrativeStatus?: ProcessNarrativeStatus; answeredIds?: Set<string> } = {}): FlowNode[] {
  const outcome = options.streaming ? undefined : options.outcome || 'completed';
  const result: FlowNode[] = [];
  const inputNode = (input: FlowInput): FlowNode => ({ id: input.id, recordedAt: input.recordedAt, category: 'input', title: input.kind === 'answer' ? '回答问题' : input.id === context.root.id ? '首次输入' : '补充输入', subtitle: clip(input.content.replace(/\s+/g, ' '), 80), hint: detailLine(input.state === 'waiting' ? input.delivery : undefined, input.attachments?.length ? `${input.attachments.length} 个附件 · ${namesSummary(input.attachments.map(item => item.name))}` : undefined), source: '用户', state: input.state, statusLabel: input.state === 'waiting' && /下一轮|排队/.test(input.delivery) ? '已排队' : undefined, text: input.content, sequence: 0, positionKnown: input.positionKnown, attachments: input.attachments });
  const inputNodes = new Map([context.root, ...context.inputs].map(input => [input.id, inputNode(input)]));
  result.push(inputNodes.get(context.root.id)!);
  const normalizeText = (text: string | undefined) => text?.trim();
  const findInput = (text: string | undefined) => {
    const matches = [...inputNodes.values()].filter(input => normalizeText(input.text) === text);
    return matches.find(input => !input.step) || matches[0];
  };
  let finalStep: ProcessStep | undefined;
  const byId = new Map([...(options.streaming ? [] : context.steps), ...steps].map(step => [step.id, step]));
  steps = [...byId.values()];
  if (!options.streaming) timeline = [...new Map([...context.timeline, ...timeline].map(entry => [entry.itemId, entry])).values()];
  const seen = new Set<string>();
  const inserted = new Set<string>();
  const insertInputs = (id?: string) => {
    for (const input of context.inputs) if (input.positionKnown && input.afterItemId === id && !inserted.has(input.id)) { result.push(inputNodes.get(input.id)!); inserted.add(input.id); }
  };
  insertInputs();
  const addStep = (step: ProcessStep) => {
    if (seen.has(step.id)) return;
    seen.add(step.id);
    if (step.type === 'subAgentActivity' && !hasVisibleProcessStep(step)) { insertInputs(step.id); return; }
    const node = { ...presentFlowStep(step, context, outcome) };
    if (node.text && (step.type === 'userMessage' || step.type === 'agentMessage')) {
      const text = normalizeText(node.text);
      const unwrapped = step.type === 'userMessage' ? node.text.replace(/^<relay_host_context>\r?\n【宿主平台信息：由 Relay 自动附加，非用户输入】\r?\n[\s\S]*?\r?\n<\/relay_host_context>\s*/, '').trim() : undefined;
      const match = step.type === 'userMessage'
        ? findInput(text) || findInput(unwrapped)
        : result.find(item => item.category === 'assistant' && timeline.some(entry => entry.type === 'narrative' && entry.itemId === item.id) && normalizeText(item.text) === text);
      if (match) { match.step = step; insertInputs(step.id); return; }
      if (step.type === 'agentMessage' && normalizeText(options.finalContent) === text) { finalStep = step; insertInputs(step.id); return; }
    }
    if (step.type === 'agentMessage' && steps.some(item => item.type === 'interaction' && item.details.sourceItemId === step.id)) { insertInputs(step.id); return; }
    if (outcome && step.status === 'in_progress' && node.state === 'unknown') node.hint = detailLine(node.hint, '本次执行已结束，此步骤结果未确认');
    if (step.type === 'interaction' && options.answeredIds?.has(step.id) && !['failed', 'stopped'].includes(node.state) && !step.details.resolvedAction) { node.state = 'completed'; node.statusLabel = '已回答'; }
    result.push(node); insertInputs(step.id);
  };
  for (const entry of timeline) {
    if (entry.type === 'narrative') {
      if (seen.has(entry.itemId) || !entry.content?.trim()) continue;
      seen.add(entry.itemId);
      const status = getProcessNarrativeStatus(timeline, entry.itemId, !options.streaming, options.narrativeStatus);
      result.push({ id: entry.itemId, recordedAt: entry.firstObservedAt, category: 'assistant', title: '说明进度', subtitle: clip(entry.content.replace(/\s+/g, ' ')), source: '助手', state: status === 'in_progress' ? 'running' : status, text: entry.content, sequence: 0, step: byId.get(entry.itemId)?.type === 'agentMessage' ? byId.get(entry.itemId) : undefined });
      insertInputs(entry.itemId);
    } else { const step = byId.get(entry.itemId); if (step) addStep(step); }
  }
  for (const step of steps) addStep(byId.get(step.id)!);
  for (const input of context.inputs) if (!inserted.has(input.id)) { const node = inputNodes.get(input.id)!; result.push({ ...node, positionKnown: false, hint: detailLine(node.hint, getFlowTimes(node).first !== undefined ? '按消息记录时间排列' : '具体发生位置未记录') }); }
  // Replayed items can arrive after newer events. Sort only recorded times;
  // missing-time slots retain their source position, without inventing timestamps.
  const timed = result.filter(node => getFlowTimes(node).first !== undefined).sort((a, b) => getFlowTimes(a).first! - getFlowTimes(b).first!);
  let timeIndex = 0;
  for (let index = 0; index < result.length; index++) if (getFlowTimes(result[index]).first !== undefined) result[index] = timed[timeIndex++];
  if (outcome || options.finalContent?.trim()) result.push({
    id: `terminal:${context.id}`, category: 'assistant', source: '助手', sequence: 0,
    title: '交付回复',
    subtitle: options.finalContent?.trim() ? clip(options.finalContent.replace(/\s+/g, ' ')) : '执行结果',
    hint: outcome === 'stopped' ? '已完成的操作保留' : undefined,
    state: outcome === 'interrupted' ? 'unknown' : outcome || 'running',
    text: options.finalContent, step: finalStep, recordedAt: options.finalRecordedAt,
  });
  let sequence = 0;
  return result.map(node => ({ ...node, contextProject: node.contextProject || flowProject(context), sequence: node.id.startsWith('missing:') ? 0 : ++sequence }));
}

export function getFlowResourceGroup(node: FlowNode): { id: string; label: string } {
  return node.resource?.group || (node.step?.type === 'webSearch' ? { id: 'web', label: '网页资源' } : { id: 'unrecorded', label: '资源未记录' });
}

export function getFlowProjectGroup(node: FlowNode): { id: string; label: string } {
  const resource = getFlowResourceGroup(node);
  if (resource.id === 'external' && node.resource?.id.startsWith('path:') && skillMember(node.resource.id.slice(5)) && /\/(?:\.agents|\.codex|plugins|plugin-cache)\//i.test(node.resource.id)) return node.contextProject || resource;
  return /^(?:project:|directory:|cross$|external$)/.test(resource.id) ? resource : node.contextProject || { id: 'unrecorded', label: '项目/仓库未记录' };
}

function capabilityLocation(node: FlowNode, path = node.resource?.id.replace(/^path:/, '') || '', parents = 1) {
  const group = node.resource?.group;
  if (group?.id === 'links') return group.label;
  if (group?.id.startsWith('skill:')) return detailLine(group.label, normalize(path).match(/\/(\.(?:codex|agents)\/skills(?:\/\.system)?)(?:\/|$)/)?.[1] || normalize(path).match(/\/plugins\/(?:cache\/)?([^/]+\/[^/]+)/)?.[1]);
  if (group?.id === 'external' && parents === 2) {
    const personal = normalize(path).match(/\/(\.(?:codex|agents)\/skills(?:\/\.system)?)(?:\/|$)/);
    if (personal) return detailLine(/\/\.system\//i.test(path) ? '系统技能' : '个人技能', personal[1]);
    const plugin = normalize(path).match(/\/plugins\/(?:cache\/)?([^/]+\/[^/]+)/);
    if (plugin) return detailLine('插件技能', plugin[1]);
  }
  const directory = parents ? normalize(path).split('/').slice(0, -parents).join('/') : normalize(path);
  if (group && /^(?:project|directory):/.test(group.id)) {
    const root = group.id.replace(/^(?:project|directory):/, '');
    return detailLine(group.label, pathKey(directory) === root ? undefined : isWithin(directory, root) ? directory.slice(root.length + 1) : fileName(directory));
  }
  return detailLine(group?.id === 'external' && parents === 2 ? '外部技能目录' : group?.label || node.contextProject?.label, directory.split('/').filter(part => part && !/^[a-z]:$/i.test(part)).slice(parents === 2 ? -3 : -2).join('/'));
}

function skillMember(path: string, explicit = false) {
  if (!path || /[$`]|^[a-z][\w+.-]*:\/\//i.test(path)) return;
  const clean = normalize(path);
  const match = clean.match(/^(.*\/skills\/(?:\.system\/)?([^/]+))\/(.+)$/i);
  if (match && /(?:^|\/)(?:ai|\.agents|\.codex)\/skills\/|(?:^|\/)(?:plugins|plugin-cache)\//i.test(clean)) return { root: match[1], name: match[2], path: match[3] };
  if (explicit && /(?:^|\/)SKILL\.md$/i.test(clean)) { const root = clean.slice(0, clean.lastIndexOf('/')); return { root, name: fileName(root), path: 'SKILL.md' }; }
}

export function describeFlowCapability(node: FlowNode): FlowCapability {
  const d = node.step?.details || {};
  const input = readInput(d.arguments || d.input || d.params);
  const command = /^(?:终端|Git · 终端)$/.test(node.source) || /^(?:exec_command|shell|terminal)$/.test(node.subtitle) ? getProcessCommand(d) || firstString(input.cmd, input.command) : '';
  const invocation = describeCommandInvocation(command);
  const provider = getFlowSourceLabel(node.source);
  const resource = node.resource?.id;
  const resourceIdentity = resource && resource !== 'uri' && resource !== 'multiple' ? resource : node.id;
  const toolPath = firstString(input.path, input.filePath, input.file_path, input.filename);
  const toolFileRead = d.readOnlyHint !== false && /(?:^|\.)(?:read|read_file|read_text_file|get_file|read_skill)$/i.test(firstString(d.tool, d.toolName, d.name).split('__').pop() || node.subtitle) && toolPath;
  const fileAction = node.step?.type === 'fileChange' || ['查看文件', '编辑文件', '登记文件变更'].includes(node.title);
  const changes = node.step?.type === 'fileChange' ? d : node.title === '登记文件变更' ? Array.isArray(d.fileChanges) ? { fileChanges: d.fileChanges } : input : undefined;
  const changedPaths = changes ? describeFileChanges(changes).paths : [];
  const explicitSkill = node.title === '读取技能' || toolFileRead && /(?:^|[\\/])SKILL\.md$/i.test(toolPath);
  const root = /MCP/.test(node.source) ? undefined : node.contextProject?.id.replace(/^(?:project|directory):/, '');
  const context = { projectPath: root, cwd: node.executionCwd || firstString(d.cwd, input.workdir, input.cwd) };
  const readPaths = describeReadCommands(command).flatMap(part => describeCommandTarget(part).paths);
  const readMembers = readPaths.map(path => skillMember(resolveResourcePath(path, context)));
  const changedMembers = changedPaths.map(path => skillMember(resolveResourcePath(path, context)));
  const sameChangedSkill = changedMembers.length > 0 && changedMembers.every(Boolean) && new Set(changedMembers.map(member => member && pathKey(member.root))).size === 1;
  const sameSkill = readMembers.length > 0 && readMembers.every(Boolean) && new Set(readMembers.map(member => member && pathKey(member.root))).size === 1;
  const readPath = explicitSkill ? readPaths.find(path => /SKILL\.md$/i.test(path)) : sameSkill && !/^git(?:\.exe|\.cmd)?\s/i.test(invocation.label || '') ? readPaths[0] : undefined;
  const script = explicitSkill ? undefined : invocation.script;
  const rawSkillPath = script || toolPath || readPath || changedPaths[0] || firstString(d.path, d.filePath, d.file);
  const target = script || readPath || (sameChangedSkill ? changedPaths[0] : undefined);
  const memberPath = target ? resolveResourcePath(target, context) : resource?.startsWith('path:') ? resource.slice(5) : '';
  const member = script || toolFileRead || fileAction || node.step?.type === 'imageView' || explicitSkill || readPath ? skillMember(memberPath, Boolean(explicitSkill)) : undefined;
  let family: string = node.category, title = FLOW_CATEGORIES[node.category], label = node.title;
  let identity = node.title, detail: string | undefined, section = '', unit = '记录';
  if (member) {
    const raw = rawSkillPath;
    const name = skillMember(raw, Boolean(explicitSkill))?.name || member.name;
    const providerId = /MCP/.test(node.source) ? provider : '';
    const ownerId = JSON.stringify([providerId, pathKey(member.root)]);
    const action = script ? invocation.check ? '检查语法' : node.title === '运行测试' ? '测试' : invocation.operation || '执行' : toolFileRead || node.title === '查看文件' || explicitSkill || readPath ? '读取' : node.title.replace(/文件$/, '');
    const batch = !script && sameSkill && !explicitSkill && readMembers.length > 1;
    const paths = batch ? readMembers.map(member => member!.path) : sameChangedSkill ? changedMembers.map(member => member!.path) : [member.path];
    const entry = [...new Map(paths.map(path => [pathKey(`${member.root}/${path}`), path])).values()].sort();
    const label = `${action} · ${entry.length > 1 ? `${entry.length} 个文件` : /^SKILL\.md$/i.test(member.path) ? 'SKILL.md' : fileName(raw || member.path)}`;
    const location = capabilityLocation(node, `${member.root}/SKILL.md`, 2);
    return { family: 'skill', title: '技能', label, detail: entry.join('、'), section: '', unit: script ? '执行' : action === '读取' ? '读取' : '操作', owner: { id: ownerId, label: detailLine(name, location)! }, id: JSON.stringify(['skill', ownerId, entry.map(path => pathKey(`${member.root}/${path}`)).sort(), action]) };
  }
  if (node.title === '读取技能' || toolFileRead && /(?:^|[\\/])SKILL\.md$/i.test(toolPath)) {
    const skillPath = toolPath || describeReadCommands(command).flatMap(part => describeCommandTarget(part).paths).find(path => /(?:^|[\\/])SKILL\.md$/i.test(path)) || resource?.replace(/^path:/, '') || '';
    family = 'skill'; title = '技能'; label = normalize(skillPath).split('/').slice(-2, -1)[0] || node.subtitle; identity = resourceIdentity; detail = capabilityLocation(node, resource?.replace(/^path:/, '') || skillPath, 2); unit = '读取';
  } else {
    const paths = toolFileRead ? [toolPath] : changes ? changedPaths : node.title === '编辑文件' ? [toolPath].filter(Boolean) : ['查看文件', '读取规则'].includes(node.title) ? readPaths : [];
    const rules = paths.length > 0 && paths.every(isRulePath);
    if (rules) {
      family = 'rule'; title = '规则'; label = (node.resource?.count || paths.length) === 1 ? node.resource?.name || fileName(paths[0]) : `${node.resource?.count || paths.length} 个规则文件`; identity = resourceIdentity; detail = resource?.startsWith('multiple') ? getFlowResourceGroup(node).label : capabilityLocation(node); unit = toolFileRead || readPaths.length ? '读取' : '操作';
    } else if (/^git(?:\.exe|\.cmd)?\s/i.test(invocation.label || '')) {
      family = 'git'; title = 'Git'; label = node.source === 'Git · 终端' ? node.title : invocation.label!; identity = invocation.label!; unit = '执行';
    } else if (/MCP/.test(node.source)) {
      family = 'mcp'; title = 'MCP'; section = provider; label = node.subtitle; identity = label === '未命名工具' ? node.id : label; unit = '调用';
    } else if (['运行脚本', '检查脚本语法', '执行代码', '运行模块'].includes(node.title)) {
      family = 'script'; title = '脚本与代码'; label = node.subtitle; identity = JSON.stringify([resource || node.id, invocation.script ? 'script' : invocation.inline || invocation.module || node.subtitle]); unit = '执行';
    } else if (fileAction) {
      family = 'file'; title = '文件操作'; label = node.subtitle; identity = resourceIdentity;
    } else if (node.step?.type === 'imageView') {
      family = 'image'; title = '图片查看'; label = node.subtitle; identity = resourceIdentity;
    } else if (node.step?.type === 'webSearch' || node.title === '搜索内容') {
      family = 'search'; title = '检索与网页'; label = node.title; identity = label; unit = '调用';
    } else if (node.category === 'execution') {
      title = '终端命令'; label = invocation.label || node.subtitle; identity = invocation.label || node.id; unit = '执行';
    } else if (node.step?.type === 'subAgentActivity') {
      label = getSubAgentActivityStepInfo(d).title;
      identity = string(d.agentThreadId) || node.id;
      detail = getFlowStatusLabel(node); unit = '记录';
    } else if (['input', 'assistant'].includes(node.category) && !node.id.startsWith('missing:')) {
      identity = node.title; label = node.title === '说明进度' ? '进度说明' : node.title; unit = '消息';
    } else if (node.category === 'other' || node.id.startsWith('missing:')) {
      identity = node.id; label = node.title;
      if (node.id.startsWith('missing:')) { label = '历史上下文提示'; detail = '原始用户输入未加载'; }
    } else if (node.category === 'tooling' || node.category === 'reading') {
      label = firstString(d.tool, d.toolName, d.name) || node.title; identity = label;
    } else if (node.category === 'system') {
      identity = JSON.stringify([node.step?.type, d.noticeType, d.kind, node.title]);
    }
  }
  // Local entries keep their working scope; MCP capabilities aggregate arguments within their service.
  const cwd = node.executionCwd || resolveResourcePath(firstString(d.cwd, input.workdir, input.cwd) || root || '.', { projectPath: root });
  const targets = [];
  if (/^(?:git|npm|pnpm|yarn)\b/.test(invocation.label || '')) for (const match of command.matchAll(/(?:^|\s)(-C|-w|--prefix|--workspace|--cwd|--dir|--git-dir|--work-tree)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))|"[^"]*"|'[^']*'|([;&|\r\n])/g)) {
    if (match[5]) break;
    if (match[1]) targets.push(match.slice(1, 5).filter(Boolean));
  }
  const scope = ['mcp', 'skill', 'rule', 'file', 'image'].includes(family) ? '' : JSON.stringify([getFlowProjectGroup(node).id, pathKey(cwd), targets]);
  if (family === 'file' || family === 'image' || family === 'script') {
    if (resource === 'multiple' || resource?.startsWith('multiple:')) {
      const files = node.step?.type === 'fileChange' ? describeFileChanges(d).paths : Array.isArray(input.reportedFileChanges) ? input.reportedFileChanges.map(value => string(value?.path)).filter(Boolean) : describeCommandTarget(command).paths;
      label = `${node.resource?.count || new Set(files).size || '多'} 个文件`;
      detail = getFlowResourceGroup(node).label;
    } else {
      label = invocation.script ? fileName(invocation.script) : family === 'script' ? node.subtitle : node.resource?.name || fileName(node.subtitle);
      detail = capabilityLocation(node, undefined, family === 'script' && !invocation.script ? 0 : 1);
    }
  }
  if (family === 'git' || family === 'execution') detail = detailLine(getFlowProjectGroup(node).label, invocation.label);
  return { family, title, label, detail, section, unit, id: JSON.stringify([family, /MCP/.test(node.source) ? provider : '', scope, identity]) };
}

export function groupFlowCapabilities(nodes: FlowNode[], grouping: FlowGrouping): FlowCapabilityBucket[] {
  const buckets = new Map<string, FlowCapabilityBucket>();
  for (const node of nodes) {
    const ability = describeFlowCapability(node);
    const existing = buckets.get(ability.id);
    if (existing) existing.nodes.push(node);
    else buckets.set(ability.id, { id: ability.id, family: ability.family, label: ability.label, detail: ability.detail, unit: ability.unit, section: grouping === 'action' ? ability.section : grouping === 'tool' ? ability.title : [ability.title, ability.section].filter(Boolean).join(' · '), nodes: [node] });
  }
  return [...buckets.values()].map(bucket => {
    const family = bucket.family;
    const latest = bucket.nodes[bucket.nodes.length - 1];
    if (latest.step?.type === 'subAgentActivity') bucket.detail = getFlowStatusLabel(latest);
    if (bucket.unit === '消息') bucket.detail = `${bucket.nodes.length > 1 ? '最新：' : ''}${clip((latest.text || latest.subtitle).replace(/\s+/g, ' '), 100)}`;
    if (family === 'file' || family === 'rule') {
      const actions = new Map<string, number>();
      const batch = /个(?:规则)?文件$/.test(bucket.label);
      for (const node of bucket.nodes) {
        const projectPath = /MCP/.test(node.source) ? undefined : node.contextProject?.id.replace(/^(?:project|directory):/, '');
        const changeSource = node.step?.type === 'fileChange' ? node.step.details : node.title === '登记文件变更' ? readInput(node.step?.details.arguments || node.step?.details.input || node.step?.details.params) : undefined;
        const change = changeSource ? describeFileChanges(changeSource, path => path ? pathKey(resolveResourcePath(path, { projectPath, cwd: node.executionCwd || firstString(node.step?.details.cwd, changeSource.workdir, changeSource.cwd) })) : '') : undefined;
        const counts = change ? batch && change.counts ? [...change.counts.matchAll(/(新增|删除|修改|变更) (\d+)/g)].map(match => [match[1], Number(match[2])] as const) : [[change.action, batch ? node.resource?.count || change.paths.length : 1] as const] : [[['查看文件', '读取规则'].includes(node.title) ? '读取' : node.title.replace(/文件$/, ''), 1] as const];
        for (const [action, count] of counts) actions.set(action, (actions.get(action) || 0) + count);
      }
      bucket.summary = [...actions].map(([action, count]) => `${action} ${count}${batch ? '个' : '次'}`).join(' · ') + (batch ? ' · 展开查看文件清单' : '');
      if (family === 'rule') { if (actions.size === 1 && actions.has('读取')) bucket.summary = undefined; else bucket.unit = '操作'; }
    }
    if (family === 'mcp') bucket.detail = detailLine(...[...new Set(bucket.nodes.map(node => node.title))].filter(title => title !== '调用工具').slice(0, 3));
    if (!bucket.detail) { const text = latest.subtitle !== bucket.label ? latest.subtitle : latest.hint; if (text) bucket.detail = `${bucket.nodes.length > 1 ? '最新：' : ''}${clip(text.replace(/\s+/g, ' '), 100)}`; }
    return bucket;
  });
}

export function getFlowCategoryGroups(group: FlowGroup, grouping: FlowGrouping): FlowGroup[] {
  if (group.owner) return [];
  if (group.appearance === 'skill') {
    const groups = new Map<string, FlowGroup>();
    for (const node of group.nodes) {
      const ability = describeFlowCapability(node);
      const owner = ability.owner || { id: node.id, label: detailLine(ability.label, ability.detail)! };
      const id = `skill:${owner.id}`;
      const existing = groups.get(id);
      if (existing) existing.nodes.push(node); else groups.set(id, { id, title: owner.label, appearance: 'skill', owner: true, nodes: [node] });
    }
    return [...groups.values()];
  }
  if (grouping === 'action') return [];
  const categories = groupFlowNodes(group.nodes, 'category', 'action');
  return categories.length === 1 && categories[0].title === group.title ? [] : categories;
}

export function groupFlowNodes(nodes: FlowNode[], mode: Exclude<ProcessView, 'list'>, grouping: FlowGrouping = 'action'): FlowGroup[] {
  if (mode === 'category') {
    const groups = new Map<string, FlowGroup>();
    for (const node of nodes) {
      const source = getFlowSourceLabel(node.source);
      const resource = getFlowProjectGroup(node);
      const ability = describeFlowCapability(node);
      const id = grouping === 'tool' ? source : grouping === 'resource' ? resource.id : ability.family;
      const title = grouping === 'tool' ? source : grouping === 'resource' ? resource.label : ability.title;
      const key = grouping === 'action' ? `category:${id}` : `${grouping}:${id}`;
      const group = groups.get(key);
      if (group) group.nodes.push(node); else groups.set(key, { id: key, title, appearance: grouping === 'tool' ? /MCP/.test(source) ? 'mcp' : source : grouping === 'resource' ? 'project' : ability.family, nodes: [node] });
    }
    return [...groups.values()];
  }
  const groups: FlowGroup[] = [];
  for (const node of nodes) {
    const previous = groups[groups.length - 1];
    const first = previous?.nodes[0];
    if (previous && first && first.category === node.category && first.source === node.source && !['input', 'assistant', 'interaction', 'collaboration'].includes(node.category)) previous.nodes.push(node);
    else groups.push({ id: `group:${node.id}`, title: FLOW_CATEGORIES[node.category], nodes: [node] });
  }
  return groups;
}
