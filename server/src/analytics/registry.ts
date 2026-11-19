import type { AnalyticsFeatureProperties, AnalyticsFeatureResult, AnalyticsToolId } from './feature-schema.js';
export type { AnalyticsFeatureProperties } from './feature-schema.js';

// Shared with the browser. Keep this module free of Node imports and side effects.
export const ANALYTICS_SURFACES = [
  'unknown','sidebar','user_menu','header','button','keyboard','context_menu','mobile_sheet',
  'composer','add_content','device_picker','host_picker','drop','paste','message','message_file',
  'message_menu','preview_toolbar','preview_tab','preview_content','settings','notification',
  'share_page','tools','workbench','news','admin','system',
] as const;
export const ANALYTICS_TOOL_IDS = ['news','calendar','weather','greeting','timestamp','json','qr','diff','pomodoro','units','dates','shopping','random'] as const;
export const ANALYTICS_RESULTS = [
  'success','invalid_input','error','cancelled','rejected','throttled','unknown',
] as const;
export const ANALYTICS_MAX_DURATION = 86_400_000;
export const ANALYTICS_ATTRIBUTE_VALUES = {
  fileKind: ['text','code','markdown','html','image','pdf','word','spreadsheet','archive','audio','video','other'],
  sizeBucket: ['empty','under_1mb','1_5mb','5_20mb','over_20mb'],
  countBucket: ['0','1','2_5','6_20','over_20'],
  engine: ['codex','codebuddy','opencode','zcode','other'],
  settingKey: [
    'profile','avatar','username','password','default_project','default_engine','default_model',
    'theme','background','notification','sound','volume','preview_capacity','preview_image','concurrency',
  ],
  mode: [
    'source','rendered','git_diff','compressed','original','light','dark','system',
    'all','following','frequent','project','session','single','selection','desktop','mobile',
  ],
  section: ['profile','security','project','appearance','notifications','preview'],
  trigger: ['user','automatic'],
  reasonCode: [
    'INVALID_INPUT','UNAVAILABLE','PERMISSION_DENIED','RATE_LIMITED','NETWORK_ERROR','TIMEOUT',
    'NOT_FOUND','EXPIRED','LIMIT_REACHED','UNSUPPORTED','EMPTY_FINAL','INTERRUPTED',
    'COPY_FAILED','EXPORT_FAILED','LOAD_FAILED','OPERATION_FAILED','UNKNOWN',
  ],
  toolId: ANALYTICS_TOOL_IDS,
} as const;

export type AnalyticsSurface = typeof ANALYTICS_SURFACES[number];
export type AnalyticsGenericEventName = 'feature_view' | 'feature_action' | 'operation_result';
export type AnalyticsProducer = 'client' | 'server';
export type AnalyticsMetric = 'page' | 'view' | 'action' | 'result' | 'system' | 'hosting';
type Attribute = Exclude<keyof AnalyticsFeatureProperties,'feature'|'action'|'surface'|'result'|'operationId'>;

interface FeatureDefinition {
  label: string;
  surfaces: readonly AnalyticsSurface[];
}
export const ANALYTICS_FEATURES = {
  layout: { label:'布局与导航',surfaces:['sidebar','header','keyboard','mobile_sheet'] },
  user_menu: { label:'用户菜单',surfaces:['sidebar','user_menu','mobile_sheet'] },
  project: { label:'项目',surfaces:['sidebar','context_menu','composer','header','mobile_sheet'] },
  project_members: { label:'项目成员',surfaces:['sidebar','admin','settings'] },
  project_uploads: { label:'项目文件',surfaces:['sidebar','admin'] },
  session: { label:'会话',surfaces:['sidebar','header','context_menu','message_menu','keyboard','workbench','mobile_sheet'] },
  composer: { label:'输入区',surfaces:['composer','button','keyboard','mobile_sheet','add_content'] },
  attachments: { label:'附件',surfaces:['composer','add_content','device_picker','host_picker','drop','paste','message'] },
  notes: { label:'临时便签',surfaces:['composer','add_content','keyboard','mobile_sheet'] },
  message: { label:'消息与执行过程',surfaces:['message','message_menu','message_file','keyboard','header'] },
  interaction: { label:'授权与补充交互',surfaces:['message','notification','mobile_sheet','settings'] },
  file_preview: { label:'文件预览',surfaces:['message_file','message','preview_toolbar','preview_tab','preview_content','keyboard','mobile_sheet'] },
  share: { label:'分享',surfaces:['message_menu','header','context_menu','user_menu','share_page','mobile_sheet'] },
  trash: { label:'回收站',surfaces:['user_menu','sidebar','mobile_sheet'] },
  settings: { label:'设置中心',surfaces:['user_menu','preview_toolbar','settings','keyboard','tools','workbench','mobile_sheet'] },
  workbench: { label:'工作台',surfaces:['sidebar','workbench','keyboard','mobile_sheet'] },
  tools: { label:'工具箱',surfaces:['tools','workbench','keyboard','mobile_sheet'] },
  news: { label:'资讯',surfaces:['news','tools','sidebar','mobile_sheet'] },
  news_admin: { label:'资讯管理',surfaces:['admin','news'] },
  hosting: { label:'页面托管管理',surfaces:['user_menu','admin','drop','device_picker','host_picker'] },
  auth: { label:'登录与认证',surfaces:['button','keyboard','user_menu','settings','system'] },
  account_admin: { label:'账号管理',surfaces:['user_menu','admin'] },
  maintenance: { label:'Relay与引擎维护',surfaces:['user_menu','admin','notification','system'] },
  notifications: { label:'提醒与通知',surfaces:['notification','settings','system'] },
  connection: { label:'连接与故障恢复',surfaces:['system','notification','button'] },
  analytics: { label:'访问统计',surfaces:['admin','user_menu','keyboard'] },
  conversation: { label:'回合运行',surfaces:['composer','button','keyboard','system'] },
} as const satisfies Record<string,FeatureDefinition>;
export type AnalyticsFeature = keyof typeof ANALYTICS_FEATURES;

export interface AnalyticsRegistration {
  readonly id: string;
  readonly name: AnalyticsGenericEventName;
  readonly feature: AnalyticsFeature;
  readonly action: string;
  readonly label: string;
  readonly producer: AnalyticsProducer;
  readonly metric: 'view' | 'action' | 'result' | 'system';
  readonly outcome: 'none' | 'required';
  readonly results: readonly AnalyticsFeatureResult[];
  readonly correlated: boolean;
  readonly toolIds?: readonly AnalyticsToolId[];
  readonly attributes: readonly Attribute[];
}

const entries: AnalyticsRegistration[] = [];
const toolActions: Readonly<Partial<Record<string,readonly AnalyticsToolId[]>>> = {
  close:ANALYTICS_TOOL_IDS,pin:ANALYTICS_TOOL_IDS,unpin:ANALYTICS_TOOL_IDS,
  configure:['qr','units','pomodoro'],pause:['pomodoro'],select_day:['calendar'],change_month:['calendar'],
  change_city:['weather'],rotate_greeting:['greeting'],refresh_weather:['weather'],refresh_calendar:['calendar'],
};
const actionLabels: Readonly<Record<string,string>> = {
  open:'打开',close:'关闭',toggle_sidebar:'切换侧栏',toggle_wide:'切换宽屏',minimize:'最小化',restore:'恢复',resize:'调整宽度',
  show_quota_warning:'查看额度提醒',refresh_quota:'刷新额度',select:'选择',expand:'展开',collapse:'收起',details:'查看详情',
  create:'创建',rename:'重命名',pin:'置顶',unpin:'取消置顶',reorder:'排序',protect:'开启删除保护',unprotect:'关闭删除保护',
  delete:'删除',create_directory:'创建目录',add:'添加',remove:'移除',change_role:'修改权限',filter:'筛选',load_more:'加载更多',
  clear:'清空',activate:'切换',search:'搜索',search_result:'定位搜索结果',cancel:'取消',copy_id:'复制标识',fork:'创建分支会话',
  unarchive:'解除归档',edit_start:'开始编辑',cancel_clear:'取消清空',cancel_stop:'取消停止',select_project:'选择项目',
  select_directory:'选择目录',select_engine:'选择引擎',open_model_settings:'打开模型设置',submit:'提交消息',apply_model:'应用模型设置',apply_model_draft:'应用新会话模型草稿',remove_local:'移除本地附件',
  stop:'请求停止',cancel_queued:'取消排队',preview:'预览',upload:'上传',authorize:'授权',edit_commit:'保存编辑',insert:'插入',
  limit_reached:'达到上限',source:'查看源码',rendered:'渲染显示',select_all:'全选',cancel_selection:'取消多选',load_history:'加载历史',
  scroll_bottom:'返回底部',expand_process:'展开过程',expand_plan:'展开计划',expand_files:'展开文件',expand_report:'展开报告',
  expand_details:'展开详情',copy:'复制',refresh:'刷新',approve:'允许',approve_session:'会话允许',reject:'拒绝',
  batch_approve:'批量允许',batch_reject:'批量拒绝',submit_answer:'提交回答',submit_mcp:'提交MCP表单',save_trust:'保存信任配置',
  clear_trust:'清除信任配置',close_all:'全部关闭',maximize:'最大化',mode:'切换模式',request_scripts:'请求启用脚本',
  cancel_scripts:'取消启用脚本',enable_scripts:'启用脚本',select_sheet:'切换工作表',browse_archive:'浏览压缩目录',
  search_archive:'搜索压缩目录',play:'播放',pause:'暂停',ended:'播放结束',copy_path:'复制路径',download:'下载',
  open_external:'在外部打开',load:'加载',media_error:'媒体失败',configure:'配置',revoke:'撤销',copy_link:'复制链接',
  export_html:'导出HTML',load_public:'加载公开分享',delete_permanently:'永久删除',section:'切换分类',preview_theme:'预览主题',
  discard:'放弃更改',sound_preview:'试听',save:'保存',upload_asset:'上传素材',delete_asset:'删除素材',open_session:'进入会话',
  link_session:'关联会话',unlink_session:'解绑会话',reset_quota:'重置额度',select_day:'选择日期',change_month:'切换月份',
  change_city:'切换城市',rotate_greeting:'切换问候',save_settings:'保存设置',refresh_weather:'刷新天气',
  show_rule_matches:'查看规则匹配',save_preferences:'保存偏好',verify_source:'验证来源',save_source:'保存来源',
  refresh_source:'刷新来源',add_item:'新增内容',correct_item:'纠正内容',save_category:'保存分类',preview_policy:'预览策略',
  save_policy:'保存策略',select_entry:'选择入口',import:'导入',inspect:'检查',publish:'发布',update:'更新',
  enable:'启用',disable:'禁用',submit_login:'提交登录',retry_initialization:'重试初始化',logout:'退出登录',
  change_password:'修改密码',change_username:'修改登录名',change_project_permission:'修改项目创建权限',reset_password:'重置密码',
  select_action:'选择维护动作',confirm:'确认',show_output:'查看输出',check_version:'检查版本',recheck:'重新检测',
  install:'安装',upgrade:'升级',restart:'重启',abort:'中止',preview_repair:'预览修复',apply_repair:'执行修复',
  upgrade_and_restart:'升级并重启',
  service_restart:'请求重启Relay服务',service_repair:'请求修复Relay环境',
  dismiss:'关闭提醒',request_permission:'申请通知权限',permission:'通知权限结果',deliver:'通知投递',retry:'重试',
  initialize:'初始化',disconnect:'连接中断',recover:'连接恢复',page_error:'页面失败',range:'选择时间范围',
  metric:'切换指标',run:'回合运行',paginate:'翻页',refresh_calendar:'刷新日历',
};
function register(
  feature: AnalyticsFeature, name: AnalyticsGenericEventName, actions: readonly string[],
  producer: AnalyticsProducer, outcome: AnalyticsRegistration['outcome'],
  attributes: readonly Attribute[] = [], correlated = false, metric?: AnalyticsRegistration['metric'],
) {
  for (const action of actions) {
    if (!actionLabels[action]) throw new Error(`Missing analytics action label: ${action}`);
    const failureOnly = name === 'operation_result' && (action === 'media_error' || (feature === 'connection' && ['page_error','disconnect'].includes(action)));
    const toolIds = feature === 'tools' ? toolActions[action] : undefined;
    entries.push(Object.freeze({
    id: `${feature}.${action}${name === 'operation_result' ? '.result' : ''}`,
    name, feature, action, label: `${ANALYTICS_FEATURES[feature].label}·${actionLabels[action]}`,
    producer, outcome, correlated, attributes: Object.freeze([...attributes,...(toolIds ? ['toolId'] as const : [])]),
    ...(toolIds ? {toolIds:Object.freeze([...toolIds])} : {}),
    results: Object.freeze(outcome === 'none' ? [] : failureOnly ? ['error'] as const : [...ANALYTICS_RESULTS]),
    metric: metric ?? (name === 'feature_view' ? 'view' : name === 'feature_action' ? 'action' : 'result'),
    }));
  }
}
function view(feature: AnalyticsFeature, attributes: readonly Attribute[] = []) {
  register(feature,'feature_view',['open'],'client','none',attributes);
}
function action(feature: AnalyticsFeature, actions: readonly string[], attributes: readonly Attribute[] = []) {
  register(feature,'feature_action',actions,'client','none',attributes);
}
function local(feature: AnalyticsFeature, actions: readonly string[], attributes: readonly Attribute[] = []) {
  register(feature,'feature_action',actions,'client','required',['durationMs','reasonCode',...attributes]);
}
function remote(feature: AnalyticsFeature, actions: readonly string[], attributes: readonly Attribute[] = []) {
  register(feature,'feature_action',actions,'client','none',attributes.filter(attribute => attribute !== 'queued'),true);
  register(feature,'operation_result',actions,'server','required',['durationMs','reasonCode',...attributes],true);
}

action('layout',['toggle_sidebar','toggle_wide','resize','expand','collapse']);
view('user_menu'); action('user_menu',['show_quota_warning']); local('user_menu',['refresh_quota']);
view('project'); action('project',['select','expand','collapse']);
remote('project',['create','rename','pin','unpin','reorder','protect','unprotect','update']);
view('project_members'); remote('project_members',['remove','change_role'],['countBucket']);
view('project_uploads'); action('project_uploads',['select'],['countBucket']);
remote('project_uploads',['delete'],['countBucket']);
view('session');register('session','feature_view',['details'],'client','none');action('session',['search','search_result','cancel'],['countBucket']);
local('session',['copy_id']);
remote('session',['create','rename','pin','unpin','reorder','fork','unarchive','update'],['engine']);
view('composer'); action('composer',['edit_start','clear','cancel_clear','cancel_stop','select_project','select_directory','select_engine','open_model_settings'],['engine']);
remote('composer',['submit'],['engine','countBucket','queued']);
remote('composer',['apply_model','cancel_queued'],['engine']);
action('composer',['apply_model_draft'],['engine']);
action('composer',['stop'],['engine']);
view('attachments'); action('attachments',['select','cancel'],['fileKind','sizeBucket','countBucket']);
action('attachments',['remove_local']);
remote('attachments',['upload','remove','authorize','create_directory'],['fileKind','sizeBucket','countBucket']);
view('notes'); action('notes',['create','edit_commit','activate','insert','delete','limit_reached']);
local('notes',['copy']);
action('message',[
  'source','rendered','select','cancel_selection','search','search_result','load_history',
  'scroll_bottom','expand_process','expand_files','expand_report','expand_details','close',
],['countBucket']);
local('message',['copy','refresh']);
view('interaction'); action('interaction',['expand','collapse','cancel'],['countBucket']);
remote('interaction',['approve','approve_session','reject','submit_answer','submit_mcp','save_trust','clear_trust'],['countBucket']);
view('file_preview',['fileKind']); action('file_preview',[
  'activate','close','close_all','pin','unpin','maximize','minimize','restore','resize','details','mode','request_scripts',
  'cancel_scripts','enable_scripts','select_sheet','browse_archive','search_archive','play','pause',
],['fileKind','mode']);
register('file_preview','feature_action',['ended'],'client','none',['fileKind'],false,'system');
local('file_preview',['copy_path','download'],['fileKind','sizeBucket']);
remote('file_preview',['authorize'],['fileKind']);
register('file_preview','operation_result',['load','refresh','media_error'],'client','required',['durationMs','reasonCode','fileKind','sizeBucket'],true);
view('share'); action('share',['configure','select','minimize','restore'],['mode','countBucket']);
remote('share',['create','revoke','delete'],['mode','countBucket']);
local('share',['preview'],['mode','countBucket']);
local('share',['copy_link','open_external','export_html']);
register('share','operation_result',['load_public'],'client','required',['durationMs','reasonCode'],true);
view('trash'); action('trash',['mode','search','filter','load_more','preview','cancel'],['mode','countBucket']);
remote('trash',['restore','delete','delete_permanently'],['mode','countBucket']);
view('settings',['section']); action('settings',['section','minimize','restore','preview_theme','discard','cancel'],['section','settingKey','mode']);
local('settings',['sound_preview']);
remote('settings',['save','upload_asset','delete_asset'],['section','settingKey','mode','sizeBucket']);
view('workbench'); action('workbench',['filter','search','details','load_more','open_session','mode'],['mode','countBucket']);
local('workbench',['open_external']);
local('workbench',['refresh','refresh_quota'],['mode']);
remote('workbench',['link_session','unlink_session','reset_quota'],['mode']);
// Existing tool_open/tool_action/news_click remain the only producers of their original operations.
action('tools',['close','filter','search','configure','pause','select_day','change_month','change_city','rotate_greeting'],['mode']);
remote('tools',['pin','unpin'],['mode']);local('tools',['refresh_weather','refresh_calendar'],['mode']);
action('news',['filter','search','load_more','mode','show_rule_matches'],['mode','countBucket']);
local('news',['refresh']);remote('news',['save_preferences']);
view('news_admin'); remote('news_admin',['verify_source','save_source','refresh_source','add_item','correct_item','save_category','preview_policy','save_policy']);
action('news_admin',['section','cancel']);
view('hosting');action('hosting',['select_entry','preview','cancel'],['countBucket']);
local('hosting',['upload','import'],['countBucket','sizeBucket']);
remote('hosting',['publish','update','delete'],['countBucket','sizeBucket']);
local('hosting',['copy_link','open_external']);
action('auth',['retry_initialization']);
// Login outcomes already use login_result; do not register a second equivalent result.
remote('auth',['change_password','change_username']);
register('auth','operation_result',['logout'],'server','required',['reasonCode'],true);
view('account_admin'); action('account_admin',['cancel']);
remote('account_admin',['create','disable','enable','change_project_permission','reset_password']);
view('maintenance',['engine']); action('maintenance',['select_action','confirm','cancel','service_restart','service_repair'],['engine']);
remote('maintenance',['recheck','install','upgrade','upgrade_and_restart','restart','apply_repair'],['engine']);
local('maintenance',['check_version','preview_repair'],['engine']);action('maintenance',['abort'],['engine']);
view('notifications'); action('notifications',['dismiss','activate','request_permission']);
register('notifications','operation_result',['permission','deliver'],'client','required',['reasonCode'],true,'system');
action('connection',['retry']);
register('connection','operation_result',['initialize','disconnect','recover','page_error'],'client','required',['durationMs','reasonCode','trigger'],true,'system');
action('analytics',['range','filter','expand','metric','select_day','details','refresh','retry','paginate']);
register('conversation','operation_result',['run'],'server','required',['durationMs','queueWaitMs','firstOutputMs','engine','reasonCode','trigger'],true);
// Closing a mounted feature can also follow navigation or another action. Keep the observation,
// but do not inflate explicit user-operation totals with lifecycle cleanup.
for(const feature of ['user_menu','notes','share','settings','workbench','maintenance'] as const)
  register(feature,'feature_action',['close'],'client','none',[],false,'system');

export const ANALYTICS_REGISTRY: readonly AnalyticsRegistration[] = Object.freeze(entries);
const byKey = new Map(entries.map(entry => [`${entry.name}:${entry.feature}:${entry.action}`,entry]));
if (byKey.size !== entries.length) throw new Error('Duplicate analytics registration');

export function findAnalyticsRegistration(name: string, feature: string, actionName: string) {
  return byKey.get(`${name}:${feature}:${actionName}`);
}

export function analyticsPropertiesBytes(properties: unknown): number {
  return new TextEncoder().encode(JSON.stringify(properties)).byteLength;
}

export function validateAnalyticsRegistration(
  event: { name: string; properties: unknown }, producer: AnalyticsProducer,
  ctx: {addIssue:(issue:{code:'custom';message:string;path:string[]})=>void},
) {
  if (!['feature_view','feature_action','operation_result'].includes(event.name)) return;
  const issue = (message: string, field?: string) => ctx.addIssue({code:'custom',message,path:['properties',...(field ? [field] : [])]});
  if (!event.properties || typeof event.properties !== 'object' || Array.isArray(event.properties)) { issue('属性必须为对象'); return; }
  const props = event.properties as AnalyticsFeatureProperties;
  if (typeof props.feature !== 'string' || typeof props.action !== 'string') { issue('功能和动作必须为字符串'); return; }
  const entry = findAnalyticsRegistration(event.name,props.feature,props.action);
  if (!entry || entry.producer !== producer) { issue('未登记的事件或采集端不匹配'); return; }
  const surfaces: readonly string[] = ANALYTICS_FEATURES[entry.feature].surfaces;
  if (!(ANALYTICS_SURFACES as readonly unknown[]).includes(props.surface)) issue('未知入口','surface');
  if (props.surface !== 'unknown' && !(producer === 'server' && props.surface === 'system') && !surfaces.includes(props.surface)) issue('入口不适用于该功能','surface');
  if (entry.outcome === 'required' && props.result === undefined) issue('必须记录操作结果','result');
  if (props.result !== undefined && entry.outcome === 'required' && !entry.results.includes(props.result)) issue('结果不适用于该操作','result');
  if (entry.outcome === 'none' && props.result !== undefined) issue('意图或功能访问不能声明结果','result');
  if (props.result === 'success' && props.reasonCode !== undefined) issue('成功结果不能携带失败原因','reasonCode');
  if (entry.correlated && !props.operationId) issue('此操作必须携带关联标识','operationId');
  if (!entry.correlated && props.operationId !== undefined) issue('此操作不需要关联标识','operationId');
  if (entry.toolIds && (!props.toolId || !entry.toolIds.includes(props.toolId))) issue('操作不适用于该工具或缺少工具标识','toolId');
  const allowed = new Set<string>(['feature','action','surface',...(entry.outcome === 'required' ? ['result'] : []),...(entry.correlated ? ['operationId'] : []),...entry.attributes]);
  for (const key of Object.keys(props)) if (!allowed.has(key)) issue('此事件不允许该属性',key);
  if (props.operationId !== undefined && (typeof props.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(props.operationId))) issue('关联标识必须为UUID','operationId');
  for (const key of ['durationMs','queueWaitMs','firstOutputMs'] as const) {
    const value = props[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > ANALYTICS_MAX_DURATION)) issue('耗时超出范围',key);
  }
  if (props.queued !== undefined && typeof props.queued !== 'boolean') issue('排队状态必须为布尔值','queued');
  for (const [key,values] of Object.entries(ANALYTICS_ATTRIBUTE_VALUES)) {
    const value = (props as Record<string,unknown>)[key];
    if (value !== undefined && !(values as readonly unknown[]).includes(value)) issue('未知属性值',key);
  }
  if (props.trigger === 'automatic' && entry.metric === 'action') issue('用户操作不能声明为自动触发','trigger');
  if (analyticsPropertiesBytes(props) > 512) issue('事件属性超过512 UTF-8字节');
}
