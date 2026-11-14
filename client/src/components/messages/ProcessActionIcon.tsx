const PATHS = {
  approval: 'M8 1.5 13 4v4c0 3-5 6-5 6S3 11 3 8V4z',
  question: 'M5 5a3 3 0 1 1 5 2c-1 1-2 1-2 3M8 13h.01',
  terminal: 'M2 3h12v10H2zM4 6l2 2-2 2M8 10h3',
  edit: 'M3 10v3h3l7-7-3-3zM8 5l3 3',
  file: 'M3 2h6l4 4v8H3zM9 2v4h4M5 8h5M5 11h5',
  search: 'M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M10 10l3 3',
  remove: 'M3 4h10M6 2h4M4 4l1 10h6l1-10M7 6v6M9 6v6',
  add: 'M3 2h6l4 4v8H3zM9 2v4h4M6 10h4M8 8v4',
  skill: 'M2 3h5l1 1 1-1h5v10H9l-1 1-1-1H2zM8 4v10',
  plan: 'M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01',
  report: 'M5 3H3v11h10V3h-2M5 2h6v3H5zM5 8h6M5 11h4',
  thinking: 'M5 9a4 4 0 1 1 6 0l-1 2H6zM6 13h4M7 15h2',
  image: 'M2 3h12v10H2zM4 10l3-3 3 4 2-2M5 5h.01',
  web: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2M2 8h12M8 2c4 4 4 8 0 12-4-4-4-8 0-12',
  collaboration: 'M4 2v10M4 7h7V2M11 7v5M2 12h4v2H2zM9 12h4v2H9z',
  assistant: 'M2 3h12v8H7l-4 3v-3H2zM5 6h6M5 8h4',
  input: 'M9 2h5v12H9M2 8h8M6 4l4 4-4 4',
  system: 'M2 8h3l2-5 3 10 2-5h2',
  tool: 'M5 3 1 8l4 5M11 3l4 5-4 5M9 2 7 14',
  other: 'M3 8h.01M8 8h.01M13 8h.01',
};
export type ProcessIconKind = keyof typeof PATHS;
const ACTIONS: [RegExp, ProcessIconKind][] = [
  [/用户消息|^input$/, 'input'], [/查看图片|生成图片|图片工具|^(image|generation)$/, 'image'], [/网页|页内查找/, 'web'],
  [/授权|允许|确认/, 'approval'], [/提问|问题|回答|^interaction$/, 'question'], [/删除/, 'remove'], [/新建|新增/, 'add'],
  [/登记|记录/, 'report'], [/编辑|修改|变更|写入/, 'edit'], [/技能|^skill$/, 'skill'], [/搜索|检索|^search$/, 'search'],
  [/查看|读取|列出|^(file|rule|reading|project)$/, 'file'], [/终端|命令|脚本|代码|模块|测试|构建|检查|校验|^(script|execution)$/, 'terminal'], [/图片|生成/, 'image'],
  [/计划|^planning$/, 'plan'], [/代理|子任务|^(git|collaboration)$/, 'collaboration'], [/分析|思考|思路/, 'thinking'], [/回复|消息|^assistant$/, 'assistant'],
  [/引擎|系统|上下文|重试|连接|模型|^system$/, 'system'],
  [/调用工具|工具调用|MCP|内置工具|^(mcp|tooling)$/, 'tool'],
];
export function getProcessIconKind(action: string): ProcessIconKind {
  const label = action.split(/[：:]/, 1)[0];
  return ACTIONS.find(([pattern]) => pattern.test(label))?.[1] || 'other';
}
export default function ProcessActionIcon({ action = '', kind, size = 13 }: { action?: string; kind?: ProcessIconKind; size?: number }) {
  const resolved = kind || getProcessIconKind(action);
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-process-icon={resolved}><path d={PATHS[resolved]} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
