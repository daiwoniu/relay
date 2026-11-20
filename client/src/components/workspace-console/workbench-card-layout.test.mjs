import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export {default as MatterCard} from './MatterTaskCard'; export {default as Identity} from './FeishuIdentity'; export {default as Relations} from './DeliveryFeishuNotice'; export {default as RunRow} from './WorkspaceRunRow'; export {default as SessionPanel} from './WorkspaceSessionPanel';", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  plugins: [{ name: 'presentation-boundaries', setup(builder) {
    builder.onResolve({ filter: /analytics\/features$/ }, () => ({ path: 'analytics', namespace: 'fixture' }));
    builder.onResolve({ filter: /ui\/Tooltip$/ }, () => ({ path: 'tooltip', namespace: 'fixture' }));
    builder.onResolve({ filter: /api\/workspace-console$/ }, () => ({ path: 'workspace-api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'analytics'
      ? 'export const localAction=()=>()=>true;'
      : path === 'workspace-api' ? 'export const linkWorkspaceTaskSession=()=>{throw new Error("unexpected request")};export const unlinkWorkspaceTaskSession=linkWorkspaceTaskSession;'
      : 'export default function Tooltip({children}){return children;}', loader: 'js' }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { MatterCard, Identity, Relations, RunRow, SessionPanel } = module.exports;
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const plain = html => html.replace(/<[^>]*>/g, '');

test('a verified identity retains its own external link and an unverified ID cannot become a link', () => {
  const html = render(Identity, { label: '飞书子任务', id: '7173899176', title: '应用依赖排查', url: 'https://project.feishu.cn/p/101?subTaskId=7173899176' });
  assert.match(html, /data-feishu-identity/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(plain(html), /飞书子任务 · 7173899176 ↗/);
  const unknown = render(Identity, { label: '飞书需求', id: '7087851262', title: '司法流程' });
  assert.doesNotMatch(unknown, /<a\b/);
  assert.match(plain(unknown), /7087851262（链接未核验）/);
});

test('each linked object shows title then its own identity then status without an inner card', () => {
  const html = render(Relations, { needsRecheck: false, completed: false, linkedFeishu: [
    { key: 'parent', title: '司法数据流程', typeName: '需求', workItemId: '7087851262', pending: true, statusLabel: '数据治理节点', finished: false },
    { key: 'child', kind: 'subtask', title: '应用依赖排查', workItemId: '7173899176', pending: true, statusLabel: '当前待处理', finished: false },
  ] });
  const text = plain(html);
  assert.match(text, /司法数据流程.*需求 · 7087851262.*数据治理节点/);
  assert.match(text, /应用依赖排查.*子任务 · 7173899176.*当前待处理/);
  assert.match(text, /飞书流程 · 1 项/);
  assert.match(text, /关联个人子任务 · 1 项/);
  assert.doesNotMatch(html, /rounded-/);
});

test('unknown and completed associations remain explicit, and absent associations produce no empty panel', () => {
  assert.equal(render(Relations, { linkedFeishu: [], needsRecheck: false, completed: false }), '');
  const html = render(Relations, { needsRecheck: false, completed: false, linkedFeishu: [
    { key: 'unknown', title: '未核实关联', typeName: '需求', workItemId: '100', pending: false, associationVerified: false },
    { key: 'done', kind: 'subtask', title: '已完成排查', workItemId: '200', pending: false, finished: true, statusLabel: '已完成' },
  ] });
  assert.match(plain(html), /关联待核实/);
  assert.match(plain(html), /飞书状态未返回/);
  assert.match(html, /<details>/);
  assert.match(plain(html), /已完成排查.*子任务 · 200.*已完成/);
});

test('run rows keep completeness and observation time outside truncated descriptions', () => {
  const run = { runId: 'scan', taskId: 'task', source: 'remote-runner', status: 'running', displayName: '历史扫描', target: 'scan',
    mode: 'dry-run', startedAt: '2026-11-20 09:00:00', observedAt: '2026-11-20 09:31:00', durationSeconds: null,
    insertedRows: null, updatedRows: null, exitCode: null, committed: null, finishedAt: null, summary: '', evidenceFiles: [],
    failureReason: '很长的故障描述'.repeat(50), businessResult: { complete: false, businessWrite: false, stopReason: 'row_limit_reached' } };
  const html = render(RunRow, { run, taskTitle: '历史扫描', onOpen() {} });
  assert.equal((plain(html).match(/历史扫描/g) ?? []).length, 1);
  const businessClasses = html.match(/<span class="([^"]+)">达到本轮条数上限/)[1];
  assert.doesNotMatch(businessClasses, /truncate|line-clamp/);
  assert.match(plain(html), /全量未完成/);
  const observationClasses = html.match(/<span class="([^"]+)">最近核查：/)[1];
  assert.doesNotMatch(observationClasses, /truncate|line-clamp/);
  assert.match(plain(html), /最近核查：09:31/);
});

test('unregistered test executions show the real task title and test outcome instead of business placeholders',()=>{
 const run={runId:'project-switch-contract',taskId:null,source:'task-runner',status:'succeeded',target:'small-platform-runtime-dependency',mode:'dry-run',exitCode:0,insertedRows:null,updatedRows:null,committed:null,finishedAt:'2026-11-20 17:31:02',startedAt:'2026-11-20 17:31:00',durationSeconds:2,executionLocation:'local',evidenceFiles:['run.log'],summary:'',testResult:{framework:'junit',total:13,failures:0,errorTypes:[]},taskContext:{directory:'tasks/small-platform-runtime-dependency',title:'small-platform 血缘与应用依赖接入',association:'unregistered'}};
 const text=plain(render(RunRow,{run,onOpen(){}}));
 assert.match(text,/血缘与应用依赖接入/);assert.match(text,/任务目录已识别 · 尚未登记台账/);
 assert.match(text,/契约测试.*测试通过.*代码检查.*JUnit 测试.*13 项测试通过/);
 assert.doesNotMatch(text,/未匹配任务|业务完成情况未记录|预演模式/);
 const failed=plain(render(RunRow,{run:{...run,status:'failed',exitCode:1,testResult:{framework:'junit',total:11,failures:1,errorTypes:['NullPointerException']}},onOpen(){}}));
 assert.match(failed,/测试失败.*失败 1 项.*空指针异常/);assert.doesNotMatch(failed,/失败原因未记录/);
});

test('mobile identity puts nodes and child state below the ID while desktop keeps them alongside it', () => {
  const child = render(Identity, { label: '子任务', id: '7173899176', title: '排查', url: 'https://project.feishu.cn/demo', nodeLabel: '所属节点', nodeName: '专项开始' });
  assert.match(plain(child), /子任务 · 7173899176 ↗ · 所属节点：专项开始/);
  assert.match(child,/grid-cols-1 sm:grid-cols-/);
  assert.match(child,/--feishu-node-row:1/);
  assert.match(child,/col-start-1 row-\[calc\(var\(--feishu-node-row\)\+1\)\]/);
  assert.match(child,/sm:col-start-2 sm:row-\[var\(--feishu-node-row\)\]/);
  const parent = render(Identity, { label: '专项工作', id: '7174036095', title: '治理', nodeLabel: '当前节点', nodeNames: ['专项开始（负责人：王有才）', '推进验证（负责人：李国祥）'] });
  assert.match(plain(parent), /专项工作 · 7174036095.*当前节点：专项开始（负责人：王有才）.*当前节点：推进验证（负责人：李国祥）/);
  assert.match(parent,/--feishu-node-row:1/);assert.match(parent,/--feishu-node-row:2/);
  for (const row of parent.matchAll(/<span style="--feishu-node-row:\d+" class="([^"]+)"/g)) assert.match(row[1], /truncate whitespace-nowrap/);
  const state=render(Identity,{label:'缺陷',id:'123',title:'问题',trailingText:'状态：新建 · 新建人：张三'});
  assert.match(state,/col-start-1 row-start-2.*sm:col-start-2 sm:row-start-1/);
  assert.match(state,/hidden sm:inline/);
});

test('a continuation run shows its actual operation and boundary while unavailable progress stays unknown',()=>{
  const run={runId:'raw-english-id',taskId:'task',source:'remote-runner',status:'running',target:'same-target',mode:'dry-run',startedAt:'2026-11-20 09:19:29',observedAt:'2026-11-20 09:31:00',durationSeconds:null,insertedRows:null,updatedRows:null,exitCode:null,committed:null,finishedAt:null,summary:'',evidenceFiles:[],businessResult:null,
    operation:{title:'历史数据续扫 · 1 张表',objects:['ds_risk_executed_ent'],scope:['计划并发 1','ds_risk_executed_ent：ID 1001 → 872569017'],source:'plan',plannedBusinessWrite:false}};
  const text=plain(render(RunRow,{run,taskTitle:'司法数据entid更新',onOpen(){}}));
  assert.match(text,/历史数据续扫/);assert.match(text,/1001 → 872569017/);assert.match(text,/业务跑数/);
  assert.match(text,/登记运行中/);assert.match(text,/计划不写业务数据/);assert.match(text,/尚未采集执行进度/);
  assert.doesNotMatch(text,/raw-english-id|记录注明未写入业务数据|100%/);
});

test('local child associations include their real parent once above sibling tasks', () => {
  const parent = { workItemId:'7065309150',title:'文书/拍卖数据采集与字段解析项目',typeName:'B端机会到交付流程',url:null,nodeNames:['交付支持（负责人：李国祥）'],finished:false };
  const html = render(Relations,{needsRecheck:false,completed:false,linkedFeishu:[
    {key:'child-a',kind:'subtask',workItemId:'7173251048',title:'附件表入库',pending:true,finished:false,parent,nodeLabel:'所属节点',nodeName:'交付支持',statusOnlyLabel:'当前待处理'},
    {key:'child-b',kind:'subtask',workItemId:'7173251049',title:'附件复核',pending:true,finished:false,parent,nodeLabel:'所属节点',nodeName:'交付支持',statusOnlyLabel:'当前待处理'},
  ]});
  const text=plain(html);
  assert.equal((text.match(/文书\/拍卖数据采集与字段解析项目/g)??[]).length,1);
  assert.match(text,/7065309150.*附件表入库.*7173251048.*附件复核.*7173251049/);
  assert.match(text,/飞书信息/);
});

const cardFixture=()=>{
  const children=Array.from({length:6},(_,index)=>({id:String(7173251048+index),title:`子项${index}`,nodeId:'node',nodeName:'交付支持',owners:['me'],ownerNames:['张三'],passed:index===5,phase:index===5?'completed':'current',createdAt:`2026-11-${String(10+index).padStart(2,'0')}T09:00:00+08:00`,updatedAt:`2026-11-${String(10+index).padStart(2,'0')}T10:00:00+08:00`,localTaskIds:index===0?['active']:[]}));
  const parent={workItemId:'7065309150',title:'飞书父项',typeName:'专项工作',url:'https://project.feishu.cn/demo/story/detail/7065309150',updatedAt:'2026-11-20T09:00:00+08:00',currentNodes:[{name:'交付支持',ownerNames:['李国祥']}],myNodes:[],mySubtasks:children,localTaskIds:['active']};
  const task={id:'active',title:'本地交付标题',status:'doing',nextAction:'复核后交付',taskDocumentPath:'tasks/active/README.md',lastVerifiedAt:'2026-11-20T08:00:00+08:00',feishuWorkItemIds:[parent.workItemId],sessionIds:[],runIds:[]};
  return {entry:{kind:'group',key:'matter',unified:true,parent,members:[{kind:'local',key:'active',task}]},responsibility:{workbenchItems:[parent],items:[],localAssociated:[]},runs:[],onOpen(){},onOpenEntry(){},onStart(){},onOpenFile(){},actionLabel:()=> '新建会话'};
};

test('current card sections follow the requested order and all current relations expand as one group',()=>{
  const html=render(MatterCard,cardFixture()),text=plain(html);
  assert.match(text,/子项4.*子项3.*子项2.*子项1.*子项0/);assert.doesNotMatch(text,/子项5/);
  assert.doesNotMatch(text,/展开其余子项与关联项/);
  assert(text.indexOf('飞书父项')<text.indexOf('飞书更新时间'));assert(text.indexOf('飞书更新时间')<text.indexOf('子项4'));
  assert(text.indexOf('子项0')<text.indexOf('本地台账'));assert(text.indexOf('台账状态')<text.indexOf('下一步'));assert(text.indexOf('下一步')<text.indexOf('README.md'));assert(text.indexOf('README.md')<text.indexOf('本地更新时间'));
  assert.doesNotMatch(text,/核心文件：/);assert.match(html,/<details open="" aria-label="飞书子项"/);assert.match(text,/飞书子项 · 5 项/);
  assert.match(text,/负责人：李国祥/);assert.match(html,/subTaskId=7173251052/);assert.match(html,/target="_blank"/);
  assert.equal((html.match(/workspace-workbench__task-card/g)??[]).length,1);
  assert.match(html,/aria-label="任务状态：处理中"/);assert.doesNotMatch(text,/飞书：|本地：|当前待处理 · 处理中/);
  assert.match(text,/子任务 · 7173251052 ↗ · 状态：当前待处理 · 负责人：张三/);
  assert.match(html,/data-status-tone="doing"/);
  assert.equal((html.match(/class="workspace-workbench__task-status /g)??[]).length,1,'one summary badge per card');
});

test('each child offers new processing and can continue a verified sibling session even when that sibling is completed',()=>{
  const props=cardFixture();props.onContinueRelation=async()=>null;props.onNewRelation=()=>{};
  props.dashboard={tasks:[],sessions:[{sessionId:'session-a',title:'子项 A 会话',workspaceTargets:[{taskId:'feishu-subtask:7065309150:7173251053',targetRef:'feishu-subtask:7065309150:7173251053'}]}]};
  const text=plain(render(MatterCard,props));
  assert.equal((text.match(/继续处理/g)??[]).length,5);assert.equal((text.match(/新会话处理/g)??[]).length,5);
  props.dashboard.sessions=[];
  assert.doesNotMatch(plain(render(MatterCard,props)),/继续处理/);
  props.dashboard.sessions=[{sessionId:'a',title:'会话 A',workspaceTargets:[{taskId:'feishu:7065309150',targetRef:'feishu:7065309150'}]},{sessionId:'b',title:'会话 B',workspaceTargets:[{taskId:'feishu:7065309150',targetRef:'feishu:7065309150'}]}];
  assert.match(plain(render(MatterCard,props)),/继续处理 ▾.*会话 A.*会话 B/);
  assert.equal((plain(render(MatterCard,props)).match(/新会话处理/g)??[]).length,6,'a parent with its own sessions keeps a footer action in addition to five child actions');
});
test('summary badge exposes explanatory hover content and can receive keyboard focus',()=>{
  const hints=[],badges=[];
  const visit=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}if(node.props?.content?.startsWith('汇总：'))hints.push(node.props);if(node.props?.['aria-label']?.startsWith('任务状态：'))badges.push(node.props);visit(node.props?.children);};
  visit(MatterCard(cardFixture()));
  assert.equal(hints.length,1);assert.equal(hints[0].asChild,true);assert.match(hints[0].content,/明确登记为处理中/);
  assert.equal(badges.length,1);assert.equal(badges[0].tabIndex,0);assert.equal(badges[0].children,'处理中');
});

test('NEW markers identify the specific discovered child and local ledger within an existing matter',()=>{
  const props=cardFixture();props.newKeys=new Set(['subtask:7065309150:7173251052','local:active']);
  const text=plain(render(MatterCard,props));
  assert.equal((text.match(/NEW/g)??[]).length,3);
  assert.match(text,/子项4NEW/);assert.match(text,/本地交付标题NEW/);assert.doesNotMatch(text,/子项3NEW/);
  assert.equal((plain(render(MatterCard,{...props,newKeys:new Set(['parent:7065309150'])})).match(/NEW/g)??[]).length,1,'a newly resolved parent marks the matter even with an existing local delivery');
  props.entry.members[0].task.status='done';
  props.entry.parent.mySubtasks[4].passed=true;
  assert.doesNotMatch(plain(render(MatterCard,props)),/NEW/);
});

test('completed cards use the same sections and include completed relations sorted by change time',()=>{
  const props=cardFixture();props.entry.members[0].task.status='done';props.entry.members[0].task.completedAt='2026-11-20T12:00:00+08:00';
  const html=render(MatterCard,props),text=plain(html.slice(0,html.indexOf('<details>')));
  assert.match(text,/子项5.*已完成.*子项4.*子项3/);
  assert.match(plain(html),/台账状态.*下一步.*README.md.*本地更新时间/);
  assert.doesNotMatch(plain(html),/null|undefined|verified/);
  assert.doesNotMatch(plain(html),/当前节点：|所属节点：/);
  assert.match(html,/<details aria-label="飞书子项"/);assert.doesNotMatch(html,/<details open="" aria-label="飞书子项"/);
  props.onContinueRelation=async()=>null;props.onNewRelation=()=>{};props.dashboard={tasks:[],sessions:[{sessionId:'old',title:'旧会话',workspaceTargets:[{targetRef:'feishu:7065309150'}]}]};
  const actionsText=plain(render(MatterCard,props));
  assert.match(actionsText,/重新处理/);assert.doesNotMatch(actionsText,/继续处理|新会话处理/);
});

test('one child with one exact ledger has no inner borders and only the footer contains session actions',()=>{
  const props=cardFixture();props.entry.parent.mySubtasks=props.entry.parent.mySubtasks.slice(0,1);
  const targets=[];props.onContinueRelation=async()=>null;props.onNewRelation=item=>targets.push([item.target.kind,item.id]);props.dashboard={tasks:[],sessions:[]};
  const html=render(MatterCard,props),before=html.slice(0,html.indexOf('data-card-session-footer'));
  assert.doesNotMatch(html,/workspace-workbench__relation-item/);
  assert.doesNotMatch(before,/新会话处理/);assert.equal((plain(html).match(/新会话处理/g)??[]).length,1);
  assert.equal((plain(html).match(/本地台账/g)??[]).length,1);
  assert.doesNotMatch(html,/<details/);
  const invoke=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(invoke);return;}if(node.props?.sessions&&node.props?.onNew)node.props.onNew();invoke(node.props?.children);};
  invoke(MatterCard(props));assert.deepEqual(targets,[['subtask','7173251048']]);
  props.entry.parent.mySubtasks=[];targets.length=0;invoke(MatterCard(props));assert.deepEqual(targets,[['local','active']]);
});

test('duplicate ledger titles are hidden under the card or child while local details and NEW remain accessible',()=>{
 const props=cardFixture(),opened=[];props.entry.parent.mySubtasks=[];
 props.entry.members[0].task.title='  飞书父项  ';props.newKeys=new Set(['local:active']);props.onOpenEntry=entry=>opened.push(entry.task.id);
 const text=plain(render(MatterCard,props));
 assert.equal((text.match(/飞书父项/g)??[]).length,1);assert.match(text,/台账状态：处理中NEW/);
 assert.match(text,/下一步：复核后交付/);assert.match(text,/README.md/);assert.match(text,/本地更新时间/);
 const buttons=[];const visit=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}if(node.type==='button')buttons.push(node);visit(node.props?.children);};
 visit(MatterCard(props));buttons.find(button=>button.props['aria-label']?.startsWith('打开本地台账详情')).props.onClick();assert.deepEqual(opened,['active']);
 const nested=cardFixture();nested.entry.members[0].task.title='子项0';
 assert.equal((plain(render(MatterCard,nested)).match(/子项0/g)??[]).length,1);
 nested.entry.members[0].task.title='飞书父项 · 本地实施';
 assert.match(plain(render(MatterCard,nested)),/飞书父项 · 本地实施/,'similar but different titles remain visible');
});

test('multiple unmapped ledgers have individual borders under one folding title with local actions',()=>{
  const props=cardFixture();props.entry.parent.mySubtasks=[];
  props.entry.members.push({...props.entry.members[0],key:'second',task:{...props.entry.members[0].task,id:'second',title:'第二份台账'}});
  props.onContinueRelation=async()=>null;props.onNewRelation=()=>{};props.dashboard={tasks:[],sessions:[]};
  const html=render(MatterCard,props),text=plain(html);
  assert.match(html,/<details open="" aria-label="本地台账"/);assert.match(text,/本地台账 · 2 份/);
  assert.equal((html.match(/workspace-workbench__relation-item/g)??[]).length,2);
  assert.equal((text.match(/新会话处理/g)??[]).length,2);
  assert(html.indexOf('本地台账 · 2 份')<html.indexOf('workspace-workbench__relation-item'));
});

test('missing sources are explicit and file, title and session actions preserve their exact targets',()=>{
  const props=cardFixture(),events=[];
  const task=props.entry.members[0].task;
  const local={...props,responsibility:null,entry:{kind:'local',key:'active',task:{...task,feishuWorkItemIds:[]}},onOpen:()=>events.push('detail'),onOpenFile:path=>events.push(path),onStart:entry=>events.push(entry.task.id)};
  assert.match(plain(render(MatterCard,local)),/本地交付标题.*无飞书任务/);
  const buttons=[];
  const visit=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}if(node.type==='button')buttons.push(node);visit(node.props?.children);};
  visit(MatterCard(local));
  buttons.find(button=>button.props.title==='本地交付标题').props.onClick();
  buttons.find(button=>button.props.title?.includes('tasks/active/README.md')).props.onClick();
  buttons.at(-1).props.onClick();
  assert.deepEqual(events,['detail','tasks/active/README.md','active']);
  const withoutLocal={...props,responsibility:null,entry:{...props.entry,parent:{...props.entry.parent,localTaskIds:[],mySubtasks:[]},members:[]}};
  assert.match(plain(render(MatterCard,withoutLocal)),/无本地台账/);
});

test('child titles open the exact native child and multiple ledgers require an explicit session choice',()=>{
  const props=cardFixture(),events=[];
  const buttons=[];
  const visit=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}if(node.type==='button')buttons.push(node);visit(node.props?.children);};
  visit(MatterCard({...props,onOpenEntry:entry=>events.push([entry.kind,entry.subtask?.id,entry.parent?.workItemId])}));
  buttons.find(button=>button.props.title==='子项4').props.onClick();
  assert.deepEqual(events,[['subtask','7173251052','7065309150']]);
  buttons.find(button=>button.props.title==='本地交付标题').props.onClick();
  assert.equal(events[1][0],'local');
  props.entry.members.push({...props.entry.members[0],key:'another',task:{...props.entry.members[0].task,id:'another'}});
  buttons.length=0;
  visit(MatterCard({...props,onOpen:()=>events.push('choose'),onStart:()=>events.push('unexpected-start')}));
  buttons.at(-1).props.onClick();assert.equal(events.at(-1),'choose');assert(!events.includes('unexpected-start'));
});

test('task detail processing actions are visible outside association management and keep exact target scope', () => {
  const base={taskId:'local-a',userId:'user',dashboard:{tasks:[],sessions:[]},onChanged(){},onNew(){return null;},onOpen(){}};
  const empty=render(SessionPanel,base);
  assert(empty.indexOf('开始处理')<empty.indexOf('<details'));
  const sessions=[
    {sessionId:'parent',title:'父项历史',workspaceTargets:[{taskId:'local-a',targetRef:'feishu:100'}]},
    {sessionId:'child',title:'子项历史',workspaceTargets:[{taskId:'local-a',targetRef:'feishu-subtask:100:200'}]},
  ];
  const single=render(SessionPanel,{...base,targetRef:'feishu-subtask:100:200',dashboard:{tasks:[],sessions}});
  assert(single.indexOf('继续处理')<single.indexOf('<details'));
  assert(single.indexOf('新建会话处理')<single.indexOf('<details'));
  const visibleActions=plain(single.slice(0,single.indexOf('<details')));
  assert.match(visibleActions,/子项历史/);assert.doesNotMatch(visibleActions,/父项历史/);
  const multiple=render(SessionPanel,{...base,targetRef:'feishu:100',dashboard:{tasks:[],sessions:[sessions[0],{sessionId:'second',title:'第二段历史',workspaceTargets:[{taskId:'local-a',targetRef:'feishu:100'}]}]}});
  assert.match(plain(multiple),/请选择具体会话继续处理/);
  assert.match(plain(multiple),/继续处理：父项历史/);assert.match(plain(multiple),/继续处理：第二段历史/);
});
