import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFlowNodes, getFlowStepState, groupFlowNodes, getFlowCategoryGroups, presentFlowStep, getFlowSourceLabel, getFlowStatusLabel, describeFlowCapability, groupFlowCapabilities, getFlowProjectGroup } from './process-flow-model.ts';
import { makeFlowInput, makeFlowFollowup, parseProcessView, resetFlowCategoryExpansion, hasFlowTextSelection } from './process-flow-input.ts';
import { buildCompletedFlows, captureProcessFlow, getFlowCompletionMessage } from './process-flow-session.ts';
import { describeReadRange, describeCommandTarget } from './process-flow-command.ts';

const message = (id, role = 'user', turn = 't1', extra = {}) => ({ id, role, turn_id: turn, session_id: 's1', content: id, created_at: 100, ...extra });
const step = (id, type = 'commandExecution', details = {}, status = 'completed') => ({ id, type, details, status });
const timeline = (...items) => items.map(itemId => ({ type: 'operation', itemId }));
const project = { projectPath: 'D:/work/relay', projectName: 'Relay' };
const input = (extra = {}) => ({ sessionId: 's1', messages: [message('root')], followups: [], steps: [], timeline: [], ...project, ...extra });
const followup = (id, state = 'steered', extra = {}) => ({ id, sessionId: 's1', state, content: id, createdAt: 150, replyToAsyncQuestionId: null, errorCode: null, ...extra });

test('运行过程先于原始用户输入加载时仍生成可展示上下文，不伪造输入关联', () => {
  const activity = step('activity', 'subAgentActivity', { kind: 'interacted', agentPath: '/root/food_sample' });
  assert.equal(captureProcessFlow(null, input({ messages: [], steps: [activity] })), null);
  const pending = captureProcessFlow(null, input({ messages: [], steps: [activity], allowMissingRoot: true }));
  assert.equal(pending.root.state, 'unknown');
  assert.equal(pending.root.positionKnown, false);
  assert.deepEqual(pending.inputs, []);
  assert.equal(pending.steps[0], activity);
  assert.equal(getFlowCompletionMessage(pending, [message('legacy', 'assistant', '')]), undefined);
  pending.ui.view = 'category';
  const refreshed = captureProcessFlow(pending, input({ messages: [], steps: [activity], allowMissingRoot: true }));
  assert.strictEqual(refreshed.ui, pending.ui);
  const loaded = captureProcessFlow(refreshed, input({ allowMissingRoot: true }));
  assert.equal(loaded.root.id, 'input:root');
  assert.equal(loaded.ui.view, 'category');
  assert.equal(captureProcessFlow(loaded, input({ messages: [message('done', 'assistant')], allowMissingRoot: true })), null);
  const switched = captureProcessFlow(pending, input({ sessionId: 's2', messages: [], allowMissingRoot: true }));
  assert.notStrictEqual(switched.ui, pending.ui);
});

test('时间流和分类流保留子代理路径中的任务名与活动类型', () => {
  const activity = step('activity', 'subAgentActivity', { kind: 'completed', agentPath: '/root/food_sample' });
  const node = presentFlowStep(activity, project);
  assert.equal(node.subtitle, 'food_sample');
  assert.equal(getFlowStatusLabel(node), '执行结束');
  for (const mode of ['time', 'category']) {
    const groups = groupFlowNodes([node], mode);
    assert.equal(groups.flatMap(group => group.nodes)[0].subtitle, 'food_sample');
  }
});

test('隐藏交互通知不丢失锚定其后的真实补充输入，冷恢复同样过滤', () => {
  const hidden = step('hidden', 'subAgentActivity', { kind: 'interacted', agentPath: '/root/food_sample' });
  const actual = step('visible', 'subAgentActivity', { kind: 'completed', agentThreadId: 'child' });
  const context = captureProcessFlow(null, input({ steps: [hidden, actual] }));
  context.inputs.push({ id: 'supplement', content: '补充要求', state: 'completed', positionKnown: true, afterItemId: 'hidden' });
  for (const streaming of [true, false]) {
    const nodes = buildFlowNodes(context, streaming ? [hidden, actual] : [], timeline('hidden', 'visible'), { streaming });
    assert(!nodes.some(node => node.id === 'hidden'));
    assert(nodes.some(node => node.id === 'visible'));
    const supplement = nodes.find(node => node.id === 'supplement');
    assert.equal(supplement.positionKnown, true);
    assert(nodes.indexOf(supplement) < nodes.findIndex(node => node.id === 'visible'));
  }
  assert.deepEqual(context.steps.map(step => step.id), ['hidden', 'visible']);
});

test('输入暂时缺失和恢复保留展示选择，不把旧输入及节点展开状态移给未知回合', () => {
  const first = captureProcessFlow(null, input());
  first.ui.view = 'category'; first.ui.details['old-node'] = true;
  const missing = captureProcessFlow(first, input({ messages: [], allowMissingRoot: true }));
  assert.equal(missing.ui.view, 'category');
  assert.deepEqual(missing.ui.details, {});
  assert.equal(missing.root.state, 'unknown');
  assert.equal(missing.turnId, '');
  const restored = captureProcessFlow(missing, input({ allowMissingRoot: true }));
  assert.equal(restored.ui.view, 'category');
  assert.equal(restored.root.id, 'input:root');
});

test('分类流按明确子线程归并活动，保留两轮结束记录且不合并同名不同线程', () => {
  const events = [
    ['a', 'child-a', 'completed'], ['b', 'child-a', 'interacted'], ['c', 'child-a', 'completed'],
    ['d', 'child-b', 'started'], ['e', undefined, 'started'], ['f', undefined, 'started'],
  ].map(([id, agentThreadId, kind]) => presentFlowStep(step(id, 'subAgentActivity', { agentPath: '/root/food_sample', agentThreadId, kind }), project));
  const buckets = groupFlowCapabilities(events, 'action');
  assert.equal(buckets.length, 4);
  assert.deepEqual(buckets[0].nodes.map(node => node.id), ['a', 'b', 'c']);
  assert.equal(buckets[0].label, 'food_sample');
  assert.equal(buckets[0].detail, '执行结束');
  assert.equal(buckets[1].detail, '已启动');
  assert.equal(groupFlowCapabilities(events.slice(0, 2), 'action')[0].detail, '发生交互');
  assert.deepEqual(groupFlowNodes(events, 'time').flatMap(group => group.nodes).map(node => node.id), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('技能目录脚本按所属技能和明确子命令汇总，不按脚本文件误归独立代码类', () => {
  const commands=['python ai/skills/Db/scripts/db.py --profile local query --sql "select 1"','python D:/work/relay/ai/skills/Db/scripts/db.py --profile=other query --sql "select 2"','python ai/skills/Db/scripts/db.py write --input private.json','cat ai/skills/Db/SKILL.md'];
  const nodes=commands.map((command,index)=>presentFlowStep(step(`skill-operation-${index}`,'commandExecution',{command}),project));
  assert(nodes.every(node=>describeFlowCapability(node).family==='skill'));
  const groups=groupFlowNodes(nodes,'category'); assert.equal(groups.length,1); assert.equal(groups[0].title,'技能');
  const owners=getFlowCategoryGroups(groups[0],'action'); assert.equal(owners.length,1); assert.equal(owners[0].title,'Db · Relay · ai/skills'); assert.equal(owners[0].nodes.length,4);
  const buckets=groupFlowCapabilities(owners[0].nodes,'action'); assert.equal(buckets.length,3); assert.equal(buckets[0].nodes.length,2);
  assert.equal(buckets[0].label,'query · db.py'); assert.equal(buckets[1].label,'write · db.py'); assert.equal(buckets[2].label,'读取 · SKILL.md');
  assert(!JSON.stringify(buckets.map(({label,detail})=>({label,detail}))).includes('private')); assert.deepEqual(getFlowCategoryGroups(owners[0],'action'),[]);
});

test('技能内规则资源读取、写入、图片与语法检查归同一技能并区分能力', () => {
  const nodes=[
    presentFlowStep(step('skill-rule','commandExecution',{command:'cat ai/skills/Pdf/rules/AGENTS.md'}),project),
    presentFlowStep(step('skill-ref','dynamicToolCall',{tool:'Read',arguments:{file_path:'ai/skills/Pdf/references/layout.md'}}),project),
    presentFlowStep(step('skill-write','dynamicToolCall',{tool:'Write',arguments:{file_path:'ai/skills/Pdf/assets/style.json'}}),project),
    presentFlowStep(step('skill-image','imageView',{path:'ai/skills/Pdf/assets/preview.png'}),project),
    presentFlowStep(step('skill-check','commandExecution',{command:'node --check ai/skills/Pdf/scripts/render.mjs'}),project),
  ];
  assert(nodes.every(node=>describeFlowCapability(node).family==='skill')); const owners=getFlowCategoryGroups(groupFlowNodes(nodes,'category')[0],'action');
  assert.equal(owners.length,1); assert.equal(groupFlowCapabilities(owners[0].nodes,'action').length,5);
  assert.equal(describeFlowCapability(nodes[4]).label,'检查语法 · render.mjs');
  assert.equal(describeFlowCapability(presentFlowStep(step('ordinary-image','imageView',{path:'assets/preview.png'}),project)).family,'image');
});

test('技能身份隔离不同仓库和远程服务，个人技能在项目视角沿用实际执行目录', () => {
  const make=(id,path,extra=project)=>presentFlowStep(step(id,'commandExecution',{command:`python ${path} query`}),extra);
  const local=make('global-skill','C:/Users/me/.agents/skills/Db/scripts/db.py');
  assert.equal(describeFlowCapability(local).owner.label,'Db · 个人技能 · .agents/skills'); assert.equal(getFlowProjectGroup(local).id,'project:d:/work/relay');
  assert.equal(describeFlowCapability(make('other-caller','C:/Users/me/.agents/skills/Db/scripts/db.py',{projectPath:'D:/other'})).id,describeFlowCapability(local).id);
  const a=make('repo-a','ai/skills/Db/scripts/db.py'),b=make('repo-b','ai/skills/Db/scripts/db.py',{projectPath:'D:/other'});
  assert.notEqual(describeFlowCapability(a).owner.id,describeFlowCapability(b).owner.id);
  const remote=server=>presentFlowStep(step(server,'mcpToolCall',{server,tool:'exec_command',arguments:{cmd:'python ai/skills/Db/scripts/db.py query'}}),project);
  assert.notEqual(describeFlowCapability(remote('a')).owner.id,describeFlowCapability(remote('b')).owner.id);
  assert.notEqual(describeFlowCapability(remote('a')).id,describeFlowCapability(a).id);
});

test('技能识别不采信参数或内联代码中的路径，不把未知参数值当能力', () => {
  for(const command of ['python scripts/run.py --input ai/skills/Db/scripts/db.py','node -e "console.log(\'ai/skills/Db/scripts/db.py\')"','git diff ai/skills/Db/scripts/db.py','python src/skills/Db/scripts/db.py','python ai/skills/Db/../../../scripts/run.py','python "$skill/scripts/db.py"']) assert.notEqual(describeFlowCapability(presentFlowStep(step(command,'commandExecution',{command}),project)).family,'skill',command);
  for(const command of ['python ai/skills/Db/scripts/db.py --unknown query','python ai/skills/Db/scripts/db.py secret_database']) {
    const ability=describeFlowCapability(presentFlowStep(step(command,'commandExecution',{command}),project)); assert.equal(ability.family,'skill'); assert.equal(ability.label,'执行 · db.py');
  }
  const mixed=presentFlowStep(step('cross-owner-docs','commandExecution',{command:'cat ai/skills/A/SKILL.md ai/skills/B/SKILL.md'}),project); assert.equal(describeFlowCapability(mixed).family,'file');
});

test('技能同属资源批量读取归所属技能，混合普通项目文件不强行归一个技能', () => {
  const read=command=>describeFlowCapability(presentFlowStep(step(command,'commandExecution',{command}),project));
  const a=read('Get-Content ai/skills/Db/references/a.md; Get-Content ai/skills/Db/references/b.md');
  const b=read('Get-Content D:/work/relay/ai/skills/Db/references/b.md; Get-Content D:/work/relay/ai/skills/Db/references/a.md');
  assert.equal(a.family,'skill'); assert.equal(a.label,'读取 · 2 个文件'); assert.equal(a.id,b.id);
  assert.equal(read('Get-Content README.md ai/skills/Db/references/a.md').family,'file');
});

test('复合规则读取与规则写入保持规则类，脚本或Git主要动作不因参数规则路径被冒认', () => {
  const nodes=[
    presentFlowStep(step('rule-compound','commandExecution',{command:'Get-Content ai/docs/rules/testing.md; Get-Content ai/docs/rules/delivery.md'}),project),
    presentFlowStep(step('rule-search-read','commandExecution',{command:'rg --files ai/docs/rules; Get-Content AGENTS.md'}),project),
    presentFlowStep(step('rule-write','fileChange',{path:'AGENTS.md',kind:'update'}),project),
  ];
  assert(nodes.every(node=>describeFlowCapability(node).family==='rule'));
  const buckets=groupFlowCapabilities(nodes.slice(1),'action'); assert.equal(buckets.length,1); assert.equal(buckets[0].unit,'操作'); assert.match(buckets[0].summary,/读取 1次/); assert.match(buckets[0].summary,/修改 1次/);
  for(const [command,family] of [['python scripts/check.py --input AGENTS.md','script'],['git diff AGENTS.md','git'],['rg AGENTS.md .','search'],['Write-Output "cat AGENTS.md"','execution']]) assert.equal(describeFlowCapability(presentFlowStep(step(command,'commandExecution',{command}),project)).family,family,command);
  const mcp=presentFlowStep(step('business-command','mcpToolCall',{server:'db',tool:'run_query',arguments:{command:'git status',path:'AGENTS.md'}}),project); assert.equal(describeFlowCapability(mcp).family,'mcp');
  const git=presentFlowStep(step('git-followed-skill-reference','commandExecution',{command:'git diff; Get-Content ai/skills/Db/references/schema.md'}),project);assert.equal(describeFlowCapability(git).family,'git');
});

test('文件登记和批量变更也按真实技能或规则归属，动作统计使用原始变更类型', () => {
  const skill=presentFlowStep(step('skill-batch-write','fileChange',{changes:[{path:'ai/skills/Db/assets/a.json',kind:'add'},{path:'ai/skills/Db/assets/b.json',kind:'update'}]}),project);
  const ability=describeFlowCapability(skill);assert.equal(ability.family,'skill');assert.equal(ability.label,'变更 · 2 个文件');assert.match(ability.owner.label,/^Db · Relay/);
  const registration=presentFlowStep(step('register-rule','dynamicToolCall',{tool:'relay_report_file_changes',params:{reportedFileChanges:[{path:'AGENTS.md',changeType:'modified'}]}}),project);
  assert.equal(describeFlowCapability(registration).family,'rule');const bucket=groupFlowCapabilities([registration],'action')[0];assert.equal(bucket.unit,'操作');assert.equal(bucket.summary,'修改 1次');
  const file=presentFlowStep(step('register-file','dynamicToolCall',{tool:'relay_report_file_changes',arguments:{reportedFileChanges:[{path:'src/a.ts',changeType:'added'}]}}),project);
  assert.equal(describeFlowCapability(file).family,'file');assert.equal(groupFlowCapabilities([file],'action')[0].summary,'新增 1次');
});

test('本机文件工具的明确cwd参与项目归属，远程MCP的cwd仍保持隔离', () => {
  const context={...project,knownProjects:[{path:'D:/other',name:'Other'}]};
  const args={file_path:'C:/Users/me/.agents/skills/Db/references/schema.md',cwd:'D:/other'};
  const local=presentFlowStep(step('native-cwd','dynamicToolCall',{tool:'Read',arguments:args}),context);
  assert.equal(describeFlowCapability(local).family,'skill');assert.deepEqual(getFlowProjectGroup(local),{id:'project:d:/other',label:'Other'});
  const remote=presentFlowStep(step('remote-cwd','mcpToolCall',{server:'remote',tool:'read_file',arguments:{path:args.file_path,cwd:args.cwd}}),context);
  assert.equal(getFlowProjectGroup(remote).id,'project:d:/work/relay');
  for(const [path,source] of [['C:/Users/me/.codex/skills/.system/Creator/scripts/check.py','系统技能'],['C:/Users/me/.codex/plugins/cache/vendor/package/1.0/skills/Creator/scripts/check.py','插件技能']]) {
    const node=presentFlowStep(step(path,'commandExecution',{command:`python ${path} check`}),project);assert.equal(describeFlowCapability(node).family,'skill');assert.match(describeFlowCapability(node).owner.label,new RegExp(source));
  }
});

test('切换类别清除分类与对象展开和旧定位，内层切换保留外层，时间流状态独立', () => {
  const ui={expanded:{'subgroup:terminal:rule':true,'capability:rule:AGENTS':true,'time:earlier':true,'children:agent':true},details:{step:true},categoryOpen:{tool:'tool:终端'},selectedNodeId:'step'};
  resetFlowCategoryExpansion(ui,true);
  assert.deepEqual(ui.categoryOpen,{tool:'tool:终端'}); assert.equal(ui.selectedNodeId,undefined);
  assert.deepEqual(ui.expanded,{'time:earlier':true,'children:agent':true}); assert.deepEqual(ui.details,{step:true});
  ui.expanded['subgroup:terminal:rule']=true;
  resetFlowCategoryExpansion(ui);
  assert.deepEqual(ui.categoryOpen,{}); assert(!('subgroup:terminal:rule' in ui.expanded));
});

test('深层技能切换只重置当前分组的后代，保留祖先展开标记', () => {
  const parent='tool:终端:category:skill';
  const ui={expanded:{[`subgroup:tool:终端:category:skill`]:true,[`subgroup:${parent}:skill:a`]:true,[`subgroup:${parent}:skill:b`]:true,[`capability:${parent}:skill:a:query`]:true,'time:earlier':true},details:{},categoryOpen:{tool:'tool:终端'},selectedNodeId:'old'};
  resetFlowCategoryExpansion(ui,true,parent);
  assert.deepEqual(ui.categoryOpen,{tool:'tool:终端'});assert.equal(ui.expanded['subgroup:tool:终端:category:skill'],true);
  assert(!Object.keys(ui.expanded).some(key=>key.startsWith(`subgroup:${parent}:`)||key.startsWith(`capability:${parent}:`)));assert.equal(ui.expanded['time:earlier'],true);
});

test('同一Windows技能的路径大小写别名不重复计数或拆分批量归属', () => {
  const read=command=>describeFlowCapability(presentFlowStep(step(command,'commandExecution',{command}),project));
  const batch=read('Get-Content ai/skills/Db/references/A.md D:/WORK/RELAY/AI/SKILLS/db/references/a.md');
  const single=read('cat ai/skills/Db/references/a.md');
  assert.equal(batch.family,'skill');assert(!batch.label.includes('2 个文件'));assert.equal(batch.id,single.id);
  const many=read('Get-Content ai/skills/Db/references/A.md D:/WORK/RELAY/AI/SKILLS/db/references/b.md');assert.equal(many.family,'skill');assert.equal(many.label,'读取 · 2 个文件');
  const change=describeFlowCapability(presentFlowStep(step('change-alias','fileChange',{changes:[{path:'ai/skills/Db/assets/A.json',kind:'update'},{path:'D:/WORK/RELAY/ai/skills/db/assets/a.json',kind:'update'},{path:'ai/skills/Db/assets/B.json',kind:'update'}]}),project));
  assert.equal(change.family,'skill');assert.equal(change.label,'修改 · 2 个文件');
});

test('相对cwd先按项目根目录解析，等价绝对cwd归并，不同项目保持隔离', () => {
  const call=(id,cwd,ctx=project)=>presentFlowStep(step(id,'commandExecution',{command:'python scripts/db.py query',cwd}),ctx);
  const relative=describeFlowCapability(call('relative-cwd','ai/skills/Db'));
  const absolute=describeFlowCapability(call('absolute-cwd','D:/work/relay/ai/skills/Db'));
  const other=describeFlowCapability(call('other-cwd','ai/skills/Db',{projectPath:'D:/other'}));
  assert.equal(relative.family,'skill');assert.equal(relative.id,absolute.id);assert.notEqual(relative.owner.id,other.owner.id);
  assert.equal(getFlowProjectGroup(call('project-cwd','ai/skills/Db')).id,'project:d:/work/relay');
});

test('离开会话项目的相对cwd只解析一次，不按所属目录再向上解析', () => {
  const call=(id,cwd)=>describeFlowCapability(presentFlowStep(step(id,'commandExecution',{command:'python ai/skills/Db/scripts/db.py query',cwd}),project));
  const relative=call('parent-relative','..'),absolute=call('parent-absolute','D:/work');
  assert.equal(relative.family,'skill');assert.equal(relative.id,absolute.id);
});

test('文件登记沿用本地实际cwd，远程登记不借本地根目录合并路径或变更统计', () => {
  const local=presentFlowStep(step('register-cwd','dynamicToolCall',{tool:'relay_report_file_changes',cwd:'D:/other',arguments:{reportedFileChanges:[{path:'a.ts',changeType:'modified'}]}}),project);
  assert.equal(local.resource.id,'path:d:/other/a.ts');assert.equal(getFlowProjectGroup(local).id,'directory:d:/other');
  const remote=presentFlowStep(step('register-remote','mcpToolCall',{server:'remote',tool:'relay_report_file_changes',arguments:{reportedFileChanges:[{path:'AGENTS.md',changeType:'modified'},{path:'D:/work/relay/AGENTS.md',changeType:'added'}]}}),project);
  assert.equal(remote.resource.count,2);const bucket=groupFlowCapabilities([remote],'action')[0];assert.equal(bucket.label,'2 个规则文件');assert.match(bucket.summary,/修改 1个/);assert.match(bucket.summary,/新增 1个/);
});

test('后续SKILL.md读取不抢走主要脚本或Git归属，技能脚本以自身所属技能为准', () => {
  for(const [command,family] of [['python scripts/check.py; cat ai/skills/Db/SKILL.md','script'],['git diff; Get-Content ai/skills/Db/SKILL.md','git']]) assert.equal(describeFlowCapability(presentFlowStep(step(command,'commandExecution',{command}),project)).family,family);
  const skill=describeFlowCapability(presentFlowStep(step('skill-primary','commandExecution',{command:'python ai/skills/A/scripts/run.py query; cat ai/skills/B/SKILL.md'}),project));
  assert.equal(skill.family,'skill');assert.match(skill.owner.label,/^A ·/);assert.equal(skill.label,'query · run.py');
});

test('重复批量文件按规范路径集合归并，顺序与相对写法不产生重复对象', () => {
  const nodes=[
    presentFlowStep(step('batch-a','fileChange',{changes:[{path:'src/A.ts',kind:'add'},{path:'src/B.ts',kind:'delete'}]}),project),
    presentFlowStep(step('batch-b','fileChange',{changes:[{path:'D:/work/relay/src/B.ts',kind:'delete'},{path:'D:/work/relay/src/A.ts',kind:'update'}]}),project),
  ];
  const buckets=groupFlowCapabilities(nodes,'action');
  assert.equal(buckets.length,1); assert.equal(buckets[0].label,'2 个文件'); assert.equal(buckets[0].nodes.length,2);
  assert.match(buckets[0].summary,/新增 1个/); assert.match(buckets[0].summary,/修改 1个/); assert.match(buckets[0].summary,/删除 2个/);
  const alias=describeFlowCapability(presentFlowStep(step('aliases','fileChange',{changes:[{path:'src/A.ts'},{path:'D:/work/relay/src/a.ts'}]}),project));
  assert(!alias.label.includes('2 个'));
  const mixed=groupFlowCapabilities([presentFlowStep(step('mixed-aliases','fileChange',{changes:[{path:'src/A.ts',kind:'add'},{path:'D:/work/relay/src/a.ts',kind:'add'},{path:'src/B.ts',kind:'delete'}]}),project)],'action')[0];
  assert.equal(mixed.label,'2 个文件'); assert.equal(mixed.summary,'新增 1个 · 删除 1个 · 展开查看文件清单');
});

test('远程相对路径不借本地根目录推断身份，URI缺失确定资源身份不误合并', () => {
  const nodes=['skills/Pdf/SKILL.md','D:/work/relay/skills/Pdf/SKILL.md'].map((path,index)=>presentFlowStep(step(`remote-${index}`,'mcpToolCall',{server:'remote',tool:'read_file',arguments:{path}}),project));
  assert.equal(groupFlowCapabilities(nodes,'action').length,2);
  const calls=['git status','git status'].map((cmd,index)=>presentFlowStep(step(`remote-exec-${index}`,'mcpToolCall',{server:'remote',tool:'exec_command',arguments:{cmd,...(index?{workdir:'D:/work/relay'}:{})}}),project));
  assert.equal(groupFlowCapabilities(calls,'action').length,2);
  const uris=['https://a.test/skills/Pdf/SKILL.md','https://b.test/skills/Other/SKILL.md'].map((path,index)=>presentFlowStep(step(`uri-${index}`,'mcpToolCall',{server:'remote',tool:'read_file',arguments:{path}}),project));
  assert.equal(groupFlowCapabilities(uris,'action').length,2);
});

test('技能读取识别编码前缀、组合命令、路径数组和工具别名，不把搜索和代码字符串当使用', () => {
  assert.equal(describeCommandTarget('rg a,b src').query,'a,b');
  for(const command of [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Content ai/skills/Pdf/SKILL.md',
    'rtk err cat ai/skills/Pdf/SKILL.md',
    "Get-Content -LiteralPath @('README.md','ai/skills/Pdf/SKILL.md')",
    'rg --files ai; cat ai/skills/Pdf/SKILL.md',
    'gc ai/skills/Pdf/SKILL.md',
  ]) { const ability=describeFlowCapability(presentFlowStep(step(command,'commandExecution',{command}),project)); assert.equal(ability.family,'skill',command); assert.equal(ability.label,'读取 · SKILL.md'); assert.match(ability.owner.label,/Pdf/); }
  for(const command of ['git diff ai/skills/pdf/SKILL.md','rg SKILL.md ai','Write-Output "Get-Content ai/skills/pdf/SKILL.md"', 'node -e "console.log(\'cat ai/skills/pdf/SKILL.md\')"','Get-Content README.md -Filter SKILL.md']) assert.notEqual(describeFlowCapability(presentFlowStep(step(command,'commandExecution',{command}),project)).family,'skill',command);
  const tool=presentFlowStep(step('alias-read','dynamicToolCall',{tool:'Read',arguments:{file_path:'ai/skills/Pdf/SKILL.md'}}),project);
  assert.equal(describeFlowCapability(tool).family,'skill'); assert.equal(describeFlowCapability(tool).label,'读取 · SKILL.md'); assert.match(describeFlowCapability(tool).owner.label,/Pdf/);
  for(const [path,family] of [['src/Widget.tsx','file'],['AGENTS.md','rule']]) assert.equal(describeFlowCapability(presentFlowStep(step(path,'dynamicToolCall',{tool:'Read',arguments:{file_path:path}}),project)).family,family);
});

test('对象摘要显示技能项目目录、文件名与操作统计，多文件明确清单', () => {
  const skill=describeFlowCapability(presentFlowStep(step('skill-label','commandExecution',{command:'cat ai/skills/Pdf/SKILL.md'}),project));
  assert.equal(skill.label,'读取 · SKILL.md'); assert.equal(skill.owner.label,'Pdf · Relay · ai/skills'); assert(!skill.owner.label.includes('D:'));
  const personal=describeFlowCapability(presentFlowStep(step('personal-label','commandExecution',{command:'cat C:/Users/me/.agents/skills/Pdf/SKILL.md'}),project));
  assert.equal(personal.owner.label,'Pdf · 个人技能 · .agents/skills'); assert(!personal.owner.label.includes('Users'));
  const nodes=['add','delete'].map((kind,index)=>presentFlowStep(step(`file-${index}`,'fileChange',{path:'src/Widget.tsx',kind}),project));
  const bucket=groupFlowCapabilities(nodes,'action')[0];
  assert.equal(bucket.label,'Widget.tsx'); assert.equal(bucket.detail,'Relay · src');
  assert.equal(bucket.summary,'新增 1次 · 删除 1次'); assert.equal(bucket.nodes.length,2);
  const read=presentFlowStep(step('same-local-read','commandExecution',{command:'cat src/Widget.tsx'}),project);
  const local=groupFlowCapabilities([...nodes,read],'action');
  assert.equal(local.length,1); assert.equal(local[0].nodes.length,3); assert.match(local[0].summary,/读取 1次/);
  assert.equal(groupFlowNodes([...nodes,read],'category','tool').length,2);
  const batch=groupFlowCapabilities([presentFlowStep(step('batch','fileChange',{changes:[{path:'a.ts',kind:'add'},{path:'b.ts',kind:'delete'}]}),project)],'action')[0];
  assert.equal(batch.label,'2 个文件'); assert.match(batch.summary,/清单/);
});

test('进度说明按消息种类归并，展示最新内容并保留每条原文和最终交付', () => {
  const nodes=buildFlowNodes(captureProcessFlow(null,input()),[],[{type:'narrative',itemId:'note1',content:'先核查数据'},{type:'narrative',itemId:'note2',content:'已确认原因'}],{streaming:false,outcome:'completed',finalContent:'修复完成'});
  const buckets=groupFlowCapabilities(nodes.filter(node=>node.category==='assistant'),'action');
  assert.equal(buckets.length,2); assert.equal(buckets[0].label,'进度说明'); assert.equal(buckets[0].unit,'消息');
  assert.equal(buckets[0].detail,'最新：已确认原因'); assert.deepEqual(buckets[0].nodes.map(node=>node.text),['先核查数据','已确认原因']);
  assert.equal(buckets[1].label,'交付回复'); assert.equal(buckets[1].detail,'修复完成');
});

test('技能与规则按完整身份汇总读取次数，保留每次状态和范围，普通Markdown不冒充规则', () => {
  const nodes=[
    presentFlowStep(step('s1','commandExecution',{command:'cat ai/skills/pdf/SKILL.md'}),project),
    presentFlowStep(step('s2','commandExecution',{command:'Get-Content ai/skills/pdf/SKILL.md -TotalCount 10'},'incomplete'),project),
    presentFlowStep(step('other-skill','commandExecution',{command:'cat C:/personal/pdf/SKILL.md'}),project),
    presentFlowStep(step('r1','commandExecution',{command:'cat AGENTS.md'}),project),
    presentFlowStep(step('r2','commandExecution',{command:'cat D:/work/relay/AGENTS.md',cwd:'D:/work'}),project),
    presentFlowStep(step('rule2','commandExecution',{command:'cat ai/docs/rules/testing.md'}),project),
    presentFlowStep(step('doc','commandExecution',{command:'cat README.md'}),project),
  ];
  const groups=groupFlowNodes(nodes,'category');
  assert.deepEqual(groups.map(group=>group.title),['技能','规则','文件操作']);
  const skills=groupFlowCapabilities(groups[0].nodes,'action');
  assert.equal(skills.length,2); assert.equal(skills[0].unit,'读取');
  assert.deepEqual(skills[0].nodes.map(node=>[node.id,node.state]),[['s1','completed'],['s2','failed']]);
  const rules=groupFlowCapabilities(groups[1].nodes,'action');
  assert.deepEqual(rules.map(bucket=>bucket.nodes.length),[2,1]);
  assert.equal(nodes[1].hint,'SKILL.md · 前 10 行 · 工作区技能');
  assert.equal(nodes[1].step.status,'incomplete');
  const remote=presentFlowStep(step('tool-skill','mcpToolCall',{server:'files',tool:'read_file',arguments:{path:'/skills/pdf/SKILL.md'}}),project);
  assert.equal(describeFlowCapability(remote).family,'skill'); assert.equal(describeFlowCapability(remote).label,'读取 · SKILL.md'); assert.match(describeFlowCapability(remote).owner.label,/pdf/);
  assert.equal(remote.subtitle,'read_file');
  const rule=presentFlowStep(step('tool-rule','mcpToolCall',{server:'files',tool:'read_file',arguments:{path:'/repo/AGENTS.md'}}),project);
  assert.equal(describeFlowCapability(rule).family,'rule');
  assert.notEqual(describeFlowCapability(remote).id,describeFlowCapability(nodes[0]).id);
});

test('MCP按服务与能力汇总，参数保留逐次记录；缺失函数身份不猜测合并', () => {
  const nodes=[
    ...['a','b'].map((path,index)=>presentFlowStep(step(`call${index}`,'mcpToolCall',{server:'Figma',tool:'get_design_context',arguments:{path}}),project)),
    presentFlowStep(step('server2','mcpToolCall',{server:'Other',tool:'get_design_context'}),project),
    presentFlowStep(step('tool2','mcpToolCall',{server:'Figma',tool:'get_screenshot'}),project),
    ...['missing1','missing2'].map(id=>presentFlowStep(step(id,'mcpToolCall',{server:'Figma'}),project)),
  ];
  const buckets=groupFlowCapabilities(nodes,'action');
  assert.equal(buckets.length,5); assert.equal(buckets[0].section,'Figma · MCP'); assert.equal(buckets[0].unit,'调用');
  assert.deepEqual(buckets[0].nodes.map(node=>node.step.details.arguments.path),['a','b']);
  assert.equal(groupFlowNodes(nodes,'category')[0].title,'MCP');
  assert.equal(groupFlowNodes(nodes,'category','resource')[0].title,'Relay');
  assert.equal(nodes[0].resource.group.id,'remote-files:Figma');
});

test('通道和项目视角保留能力分类，脚本与Git按实际工作范围归并', () => {
  const nodes=['node scripts/a.mjs','node scripts/a.mjs','git status','git status','git -C other status','node -e "1"','python -c "1"'].map((command,index)=>presentFlowStep(step(String(index),'commandExecution',{command,...(index===1||index===3?{cwd:'D:/work/relay'}:{})}),project));
  const groups=groupFlowNodes(nodes,'category','tool'); assert.equal(groups.length,1); assert.equal(groups[0].title,'终端');
  const buckets=groupFlowCapabilities(groups[0].nodes,'tool');
  assert.deepEqual(buckets.map(bucket=>bucket.nodes.length),[2,2,1,1,1]);
  assert.equal(buckets[0].section,'脚本与代码'); assert.equal(buckets[1].section,'Git');
  for(const mode of ['action','tool','resource']) assert.deepEqual(new Set(groupFlowNodes(nodes,'category',mode).flatMap(group=>groupFlowCapabilities(group.nodes,mode).flatMap(bucket=>bucket.nodes.map(node=>node.id)))),new Set(nodes.map(node=>node.id)));
  const prefixes=['npm --prefix a run test','npm --prefix=b run test'].map((command,index)=>presentFlowStep(step(`prefix${index}`,'commandExecution',{command}),project));
  assert.equal(groupFlowCapabilities(prefixes,'action').length,2);
  assert.equal(describeFlowCapability(nodes[5]).detail,'Relay');
  const inline=presentFlowStep(step('opaque-inline','commandExecution',{command:'node -e "console.log(\'--prefix private-value\')"'}),project);
  assert(!JSON.stringify(describeFlowCapability(inline)).includes('private-value'));
});

test('工具待分析命令文本不冒充执行，Git作用域忽略引号正文和后续命令', () => {
  const preview=presentFlowStep(step('preview','mcpToolCall',{server:'review',tool:'inspect',arguments:{command:'git status'}}),project);
  assert.equal(describeFlowCapability(preview).family,'mcp');
  const commit=presentFlowStep(step('commit','commandExecution',{command:'git commit -m "note --prefix private-value"'}),project);
  assert(!describeFlowCapability(commit).id.includes('private-value'));
  const commands=['git status','git status; git -C other status','git -C "other repo" status','git -C "another repo" status'];
  const nodes=commands.map((command,index)=>presentFlowStep(step(`scope-${index}`,'commandExecution',{command}),project));
  assert.deepEqual(groupFlowCapabilities(nodes,'action').map(bucket=>bucket.nodes.length),[2,1,1]);
});

test('全局技能按实际本地执行目录关联项目，远程路径不冒充本地执行目录', () => {
  const context={...project,knownProjects:[{name:'Other',path:'D:/other'}]};
  const skill=presentFlowStep(step('external-cwd','commandExecution',{command:'cat C:/Users/me/.agents/skills/pdf/SKILL.md',cwd:'D:/other'}),context);
  assert.equal(groupFlowNodes([skill],'category','resource')[0].title,'Other');
  const remote=presentFlowStep(step('remote-cwd','mcpToolCall',{server:'remote',tool:'exec_command',arguments:{cmd:'git status',workdir:'D:/other'}}),context);
  assert.equal(groupFlowNodes([remote],'category','resource')[0].title,'Relay');
});

test('分类依据实际动作，Git查询与写操作分开，工具未知语义保守归类', () => {
  for (const command of ['git status','rtk git diff','git -C D:/repo log','git --no-pager show']) assert.equal(presentFlowStep(step(command,'commandExecution',{command}),project).category,'reading',command);
  for (const command of ['git add a.ts','git -C D:/repo commit','git fetch','node scripts/run.mjs']) assert.equal(presentFlowStep(step(command,'commandExecution',{command}),project).category,'execution',command);
  assert.equal(presentFlowStep(step('opaque','mcpToolCall',{tool:'db.run',readOnlyHint:false}),project).category,'tooling');
  assert.equal(presentFlowStep(step('readonly','mcpToolCall',{tool:'db.inspect',readOnlyHint:true}),project).category,'reading');
  assert.equal(presentFlowStep(step('write-get','mcpToolCall',{tool:'get_or_create',readOnlyHint:false}),project).category,'tooling');
  for (const tool of ['get_or_create','get_and_delete','getOrCreate','readAndWrite']) assert.equal(presentFlowStep(step(tool,'mcpToolCall',{tool}),project).category,'tooling',tool);
  assert.equal(presentFlowStep(step('runtime-info','mcpToolCall',{tool:'getRuntimeInfo'}),project).category,'reading');
});

test('操作类别覆盖原始事件，三个分组维度均不遗漏不重复且保留子任务关联', () => {
  const cases=[
    ['userMessage',{text:'要求'},'input'], ['agentMessage',{text:'说明'},'assistant'],
    ['reasoning',{text:'分析'},'planning'], ['plan',{plan:[]},'planning'],
    ['enteredReviewMode',{},'planning'], ['exitedReviewMode',{},'planning'],
    ['commandExecution',{command:'cat a.ts'},'reading'], ['webSearch',{query:'资料'},'reading'],
    ['imageView',{path:'a.png'},'reading'], ['commandExecution',{command:'npm test'},'execution'],
    ['fileChange',{path:'b.ts'},'execution'], ['imageGeneration',{prompt:'生成示意图'},'generation'],
    ['collabAgentToolCall',{tool:'wait',agentResults:[{threadId:'child',status:'running'}]},'collaboration'],
    ['subAgentActivity',{agentResults:[{threadId:'child',status:'completed'}]},'collaboration'],
    ['interaction',{interactionKind:'async_question'},'interaction'], ['interaction',{interactionKind:'command_approval'},'interaction'],
    ['contextCompaction',{},'system'], ['systemNotice',{noticeType:'warning'},'system'],
    ['sleep',{},'system'], ['hookPrompt',{text:'提示'},'system'],
    ['mcpToolCall',{server:'db',tool:'unknown.inspect'},'tooling'], ['futureEvent',{},'other'],
  ];
  const nodes=cases.map(([type,details,category],index)=>{
    const node=presentFlowStep(step(`event-${index}`,type,details),project);
    assert.equal(node.category,category,type); return node;
  });
  for(const dimension of ['action','tool','resource']){
    const grouped=groupFlowNodes(nodes,'category',dimension).flatMap(group=>group.nodes);
    assert.equal(grouped.length,nodes.length); assert.equal(new Set(grouped.map(node=>node.id)).size,nodes.length);
    assert.deepEqual(new Set(grouped.map(node=>node.id)),new Set(nodes.map(node=>node.id)));
    assert.equal(grouped.find(node=>node.step.type==='collabAgentToolCall').children.length,1);
    assert(!grouped.some(node=>node.id.includes(':agent:')));
  }
});

test('提供方与资源保持独立，数据库有原始字段才分组，缺失资源不冒充来源', () => {
  const nodes=[
    presentFlowStep(step('a','mcpToolCall',{server:'db',tool:'meta_data.search',arguments:{db_name:'analytics'}}),project),
    presentFlowStep(step('b','mcpToolCall',{server:'db',tool:'meta_data.detail',arguments:{db_name:'analytics'}}),project),
    presentFlowStep(step('c','mcpToolCall',{server:'db',tool:'meta_data.detail',arguments:{db_name:'finance'}}),project),
    presentFlowStep(step('unknown','mcpToolCall',{server:'db',tool:'inspect'}),project),
  ];
  assert.equal(groupFlowNodes(nodes,'category','tool').length,1);
  assert.deepEqual(groupFlowNodes(nodes,'category','resource').map(group=>group.nodes.length),[4]);
  assert.equal(groupFlowNodes(nodes,'category','resource')[0].title,'Relay');
  assert.equal(nodes[0].resource.group.label,'数据库 · analytics（db）');
  const remote=presentFlowStep(step('remote-shell','mcpToolCall',{server:'remote',tool:'exec_command',arguments:{cmd:'node scripts/run.mjs',workdir:'D:/work/relay'}}),project);
  assert.equal(remote.resource.group.id,'remote-files:remote');
  assert.equal(groupFlowNodes([remote],'category','resource')[0].title,'Relay'); // Invocation context, not remote file ownership.
});

test('六槽语义保持动作短语、主身份、条件与提供方独立，当前项目不重复', () => {
  const cases=[
    ['commandExecution',{command:'Get-Date'},'执行命令','Get-Date',undefined,'终端'],
    ['commandExecution',{command:'node scripts/check.mjs'},'运行脚本','scripts/check.mjs','node','终端'],
    ['commandExecution',{command:'node -e "console.log(1)"'},'执行代码','Node.js',undefined,'终端'],
    ['mcpToolCall',{server:'xinshu',tool:'meta_data.search',arguments:{db_name:'analytics',keyword:'orders',limit:20}},'搜索元数据','meta_data.search','数据库：analytics · 关键词：orders · 上限 20','xinshu · MCP'],
    ['fileChange',{changes:[{path:'src/a.ts',kind:'add'},{path:'src/b.ts',kind:'add'}]},'新增文件','src/a.ts 等 2 个文件','另含：b.ts','引擎'],
    ['webSearch',{action:{type:'findInPage',pattern:'needle',url:'https://example.test/doc'}},'页内查找','needle','网页：https://example.test/doc','网页工具'],
  ];
  for(const [type,details,action,identity,condition,provider]of cases){
    const node=presentFlowStep(step(action,type,details),project);
    assert.equal(node.title,action); assert.equal(node.subtitle,identity); assert.equal(node.hint,condition); assert.equal(getFlowSourceLabel(node.source),provider);
    assert(!node.title.includes('：')); assert(!node.subtitle.startsWith('Relay ·'));
  }
});

test('授权动作不随决策改名，决策方式与结果分别进入补充行和状态行', () => {
  const raw=step('approved','interaction',{interactionKind:'command_approval',command:'node scripts/check.mjs',decisionSource:'project_trust',resolvedAction:'accept'},'in_progress');
  const approved=presentFlowStep(raw,project);
  assert.equal(approved.title,'请求授权'); assert.equal(approved.subtitle,'node scripts/check.mjs'); assert.equal(approved.hint,'决策：项目规则'); assert.equal(getFlowSourceLabel(approved.source),'引擎'); assert.equal(getFlowStatusLabel(approved),'已允许');
  const declined=presentFlowStep(step('declined','interaction',{resolvedAction:'decline'},'completed'),project);
  assert.equal(declined.title,'请求授权'); assert.equal(getFlowStatusLabel(declined),'已拒绝');
  assert.equal(getFlowStatusLabel(presentFlowStep(step('elsewhere','interaction',{resolvedAction:'resolved_elsewhere'},'completed'),project)),'已处理');
  const model=presentFlowStep(step('model','systemNotice',{noticeType:'model_rerouted',title:'模型已切换',fromModel:'old-model',toModel:'new-model'}),project);
  assert.equal(model.title,'模型切换'); assert.equal(model.subtitle,'new-model'); assert.equal(model.hint,'原模型：old-model');
  const hook=presentFlowStep(step('hook','hookPrompt',{name:'check-hook',text:'说明内容'}),project);
  assert.equal(hook.title,'显示提示'); assert.equal(hook.subtitle,'check-hook'); assert.equal(hook.hint,'说明内容');
});

test('MCP函数名始终保留在摘要，对象和专用动作不能覆盖它，也不重复函数名', () => {
  for(const [tool,args,expected] of [
    ['meta_data.search',{db_name:'analytics'},'meta_data.search · 数据库：analytics'],
    ['get_widget',{path:'widget.json'},'get_widget · widget.json'],
    ['edit_file',{path:'edit_file.ts'},'edit_file · edit_file.ts'],
    ['exec_command',{cmd:'Get-Date'},'exec_command · Get-Date'],
    ['get_design_context',{nodeId:'1:2'},'get_design_context · 设计节点 1:2'],
    ['mcp__demo__fetch_custom',{path:'item.json'},'fetch_custom · item.json'],
  ]){
    const item=step(tool,'mcpToolCall',{tool,arguments:args});
    const node=presentFlowStep(item,project);
    const identity=tool.startsWith('mcp__')?tool.split('__').slice(2).join('__'):tool;
    assert.equal(node.subtitle,identity);
    assert.equal(node.hint,expected.slice(identity.length+3));
    assert.equal(presentFlowStep(item,project).subtitle,identity);
  }
  assert.equal(presentFlowStep(step('plain','dynamicToolCall',{tool:'relay_report_file_changes',arguments:{reportedFileChanges:[{path:'a.ts'}]}}),project).subtitle,'a.ts');
});

test('原始网页动作、文件种类、系统原因及工具声明不会被通用摘要覆盖', () => {
  const open=presentFlowStep(step('open','webSearch',{action:{type:'openPage',url:'https://example.test'}}),project);
  assert.equal(open.title,'打开网页'); assert.equal(open.subtitle,'https://example.test');
  const find=presentFlowStep(step('find','webSearch',{action:{type:'findInPage',pattern:'needle'}}),project);
  assert.equal(find.title,'页内查找'); assert.equal(find.subtitle,'needle');
  const file=presentFlowStep(step('deleted','fileChange',{changes:[{path:'a.ts',kind:{type:'delete'}}]}),project);
  assert.equal(file.title,'删除文件');
  const write=presentFlowStep(step('write-get','mcpToolCall',{tool:'get_or_create_item',readOnlyHint:false}),project);
  assert.equal(write.category,'tooling');
  const shellServer=presentFlowStep(step('shell-server','mcpToolCall',{tool:'mcp__shell_service__read_file',arguments:{path:'file.ts'}}),project);
  assert.equal(shellServer.category,'reading'); assert.notEqual(shellServer.title,'执行命令');
  const noCommand=presentFlowStep(step('shell-status','mcpToolCall',{tool:'shell',arguments:{id:'session'}}),project);
  assert.equal(noCommand.title,'调用工具');
  const target=presentFlowStep(step('zero','mcpToolCall',{tool:'inspect',arguments:{table_metadata_id:0,request_id:7,page_size:10}}),project);
  assert.equal(target.subtitle,'inspect'); assert.equal(target.hint,'表ID：0 · 请求ID：7 · 页大小 10');
  const notice=presentFlowStep(step('warning','systemNotice',{noticeType:'config_warning',title:'配置提示',message:'具体原因'}),project);
  assert.equal(notice.title,'配置提示'); assert.equal(notice.hint,'具体原因');
  assert.equal(presentFlowStep(step('same','systemNotice',{title:'same',message:'same'}),project).hint,undefined);
  assert.equal(getFlowStepState(step('failed-dynamic','dynamicToolCall',{success:false})), 'failed');
  const agents=presentFlowStep(step('agent-wait','collabAgentToolCall',{tool:'wait',agentResults:[{threadId:'a',status:'running'},{threadId:'b',status:'completed'}]}),project);
  assert.equal(agents.title,'等待子任务'); assert.equal(agents.subtitle,'子任务信息未记录'); assert.equal(agents.hint,'2 个子任务 · 1 进行中 · 1 已完成');
  assert.equal(getFlowSourceLabel(open.source),'网页工具');
  assert.equal(getFlowStepState(step('elsewhere','interaction',{resolvedAction:'resolved_elsewhere'},'in_progress')),'completed');
  assert.equal(getFlowStepState(step('failed-accepted','interaction',{resolvedAction:'accept',errorCode:'FAILED'},'completed')),'failed');
  const prefix='a'.repeat(150);
  assert.equal(presentFlowStep(step('clipped','systemNotice',{title:prefix+' title',message:prefix+' message'}),project).hint,undefined);
  assert.equal(presentFlowStep(step('blank-title','systemNotice',{title:' ',message:'valid'}),project).subtitle,'valid');
  const canonical=presentFlowStep(step('canonical','mcpToolCall',{name:'descriptive title',tool:'meta_data.search',server:'canonical',serverName:'alias',arguments:{keyword:' ',searchQuery:'needle'}}),project);
  assert.equal(canonical.title,'搜索元数据'); assert.equal(canonical.source,'canonical · MCP'); assert.match(canonical.hint,/needle/);
  const image=presentFlowStep(step('image-alias','imageView',{path:' ',filePath:'image.png',cwd:'D:/outside'}),project);
  assert.match(image.subtitle,/image.png/); assert.equal(image.resource.group.id,'directory:d:/outside');
});

test('文件登记跳过空路径和重复记录，未知工具不重复名称或猜query语义', () => {
  const files=presentFlowStep(step('reported','dynamicToolCall',{tool:'relay_report_file_changes',arguments:{reportedFileChanges:[null,{path:' '},{path:'src/a.ts'},{path:'src/a.ts'},{path:'src/b.ts'}]}}),project);
  assert.equal(files.subtitle,'src/a.ts 等 2 个文件'); assert.equal(files.hint,'另含：b.ts');
  const tool=presentFlowStep(step('opaque-query','mcpToolCall',{tool:'db.execute',arguments:{query:'SELECT private_field FROM private_table'}}),project);
  assert.equal(tool.title,'调用工具'); assert.equal(tool.subtitle,'db.execute'); assert.equal(tool.hint,undefined);
  const target=presentFlowStep(step('opaque-target','mcpToolCall',{tool:'db.inspect',arguments:{db_name:'analytics'}}),project);
  assert.equal(target.title,'调用工具'); assert.equal(target.subtitle,'db.inspect'); assert.equal(target.hint,'数据库：analytics');
  const search=presentFlowStep(step('search-query','mcpToolCall',{tool:'meta_data.search',arguments:{query:'orders',limit:8}}),project);
  assert.equal(search.subtitle,'meta_data.search'); assert.match(search.hint,/关键词：orders/); assert.equal(search.hint,'关键词：orders · 上限 8');
});

test('第三行补计划快照进度、多文件对象、问题规模，简单事件保持留空', () => {
  const plan=presentFlowStep(step('plan','plan',{explanation:'检查后实现',plan:[{status:'completed'},{status:'in_progress'},{status:'pending'}]}),project);
  assert.equal(plan.subtitle,'检查后实现'); assert.equal(plan.hint,'已完成 1/3 项 · 1 项进行中');
  const multi=presentFlowStep(step('files','fileChange',{changes:[{path:'src/a.ts'},{path:'src/b.ts'},{path:'src/c.ts'},{path:'src/d.ts'}]}),project);
  assert.equal(multi.hint,'另含：b.ts、c.ts 等 3 项'); assert(!multi.hint.includes('src/'));
  const question=presentFlowStep(step('questions','interaction',{interactionKind:'async_question',questions:[{title:'选择环境',options:['开发','正式']},{title:'是否继续'}]},'in_progress'),project);
  assert.equal(question.hint,'2 个问题 · 首题 2 个选项'); assert.equal(question.state,'waiting');
  assert.equal(presentFlowStep(step('single','fileChange',{path:'a.ts'}),project).hint,undefined);
  assert.equal(presentFlowStep(step('system','contextCompaction'),project).hint,undefined);
  assert.equal(presentFlowStep(step('bad-model','systemNotice',{fromModel:{},toModel:{}}),project).hint,undefined);
  assert.equal(presentFlowStep(step('grant','interaction',{title:'授权 D:/work/relay',grantRoot:'D:/work/relay'}),project).hint,undefined);
});

test('MCP对象与条件分行，限于明确字段，不复制SQL或结果', () => {
  const tool=presentFlowStep(step('target','mcpToolCall',{tool:'meta_data.search',server:'remote',arguments:JSON.stringify({db_name:'analytics',table_metadata_id:18,keyword:'orders',limit:20,ddl_sql:'private sql',password:'private password'})}),project);
  assert.equal(tool.subtitle,'meta_data.search');
  assert.equal(tool.hint,'数据库：analytics · 表ID：18 · 关键词：orders · 上限 20');
  assert(!JSON.stringify([tool.subtitle,tool.hint]).includes('private'));
  const noTarget=presentFlowStep(step('query','mcpToolCall',{tool:'meta_data.search',arguments:{keyword:'orders',limit:0}}),project);
  assert.equal(noTarget.subtitle,'meta_data.search'); assert.equal(noTarget.hint,'关键词：orders · 上限 0');
  const invalid=presentFlowStep(step('invalid','mcpToolCall',{tool:'other.inspect',arguments:{db_name:{value:'not text'},limit:-1,depth:Infinity}}),project);
  assert.equal(invalid.hint,undefined); assert.equal(invalid.subtitle,'other.inspect');
});

test('附件摘要保留文件名，程序摘要不复制任意命令参数', () => {
  const context=captureProcessFlow(null,input({messages:[message('root','user','t1',{metadata:{},attachments:[{id:'a',kind:'uploaded_file',name:'report.csv',available:true,size:10,mimeType:'text/csv'},{id:'b',kind:'uploaded_file',name:'image.png',available:true,size:10,mimeType:'image/png'}]})]}));
  assert.equal(buildFlowNodes(context,[],[],{streaming:true})[0].hint,'2 个附件 · report.csv、image.png');
  const command=presentFlowStep(step('test-command','commandExecution',{command:'npm run test -- --token private-value'}),project);
  assert.equal(command.subtitle,'npm run test'); assert(!JSON.stringify([command.subtitle,command.hint]).includes('private'));
  const opaque=presentFlowStep(step('opaque','commandExecution',{command:'unfamiliar-tool private-value'}),project);
  assert.equal(opaque.title,'执行命令'); assert.equal(opaque.subtitle,'unfamiliar-tool'); assert.equal(opaque.hint,undefined);
  assert(!JSON.stringify([opaque.title,opaque.subtitle,opaque.hint]).includes('private-value'));
});

test('执行卡片说明PowerShell命令、包装器脚本及内联代码，文件参数不冒充脚本', () => {
  const cases=[
  [
    "Get-ChildItem -LiteralPath src | Select-Object Name",
    "执行命令",
    "Get-ChildItem",
    null
  ],
  [
    "Get-Date -Format yyyy-MM-dd",
    "执行命令",
    "Get-Date",
    null
  ],
  [
    "rtk err node --import tsx scripts/check.ts input.py",
    "运行脚本",
    "scripts/check.ts",
    "node"
  ],
  [
    "npx.cmd --no-install tsx scripts/check.ts --config other.ts",
    "运行脚本",
    "scripts/check.ts",
    "tsx"
  ],
  [
    "python.exe -c \"print('private.js')\"",
    "执行代码",
    "Python",
    null
  ],
  [
    "node -e \"require('./private.js')\"",
    "执行代码",
    "Node.js",
    null
  ],
  [
    "pwsh -NoProfile -Command \"Get-Content private.ps1\"",
    "执行代码",
    "PowerShell",
    null
  ],
  [
    "powershell.exe -File \"scripts/audit.ps1\" input.py",
    "运行脚本",
    "scripts/audit.ps1",
    "powershell.exe"
  ],
  [
    "curl.exe https://example.test --token private-value",
    "执行命令",
    "curl.exe",
    null
  ],
  [
    "node scripts/task.mjs --eval private-value",
    "运行脚本",
    "scripts/task.mjs",
    "node"
  ],
  [
    "$items = Get-ChildItem -LiteralPath src; $items.Count",
    "执行代码",
    "PowerShell",
    "变量赋值"
  ]
];
  for(const [command,title,identity,hint] of cases){
    const node=presentFlowStep(step('identity','commandExecution',{command}),project);
    assert.equal(node.title,title,command); assert.equal(node.subtitle,identity,command); assert.equal(node.hint??null,hint,command);
    assert(!JSON.stringify([node.title,node.subtitle,node.hint]).includes('private'));
  }
  const compound=presentFlowStep(step('compound','commandExecution',{command:'Get-Date; node other.mjs'}),project);
  assert.equal(compound.title,'执行命令'); assert.equal(compound.subtitle,'Get-Date');
  assert(!JSON.stringify([compound.title,compound.subtitle,compound.hint]).includes('other.mjs'));
});

test('命令身份复核区分模块和语法检查，跳过工作区参数及紧贴的shell连接符', () => {
  const cases=[
  [
    "node -c scripts/check.js",
    "检查脚本语法",
    "scripts/check.js",
    "node"
  ],
  [
    "node --check scripts/check.js",
    "检查脚本语法",
    "scripts/check.js",
    "node"
  ],
  [
    "python -m pytest --token private-value",
    "运行模块",
    "pytest",
    "python -m"
  ],
  [
    "python3.12 -W ignore -X dev scripts/check.py",
    "运行脚本",
    "scripts/check.py",
    "python3.12"
  ],
  [
    "npm --prefix client run verify --token private-value",
    "执行命令",
    "npm run verify",
    null
  ],
  [
    "git -C D:/work status --short",
    "查看状态",
    "git status",
    null
  ],
  [
    "node&&other.js",
    "执行命令",
    "node",
    null
  ],
  [
    "node&other.js",
    "执行命令",
    "node",
    null
  ],
  [
    "& \"D:/tools/audit.ps1\" input.py",
    "运行脚本",
    "audit.ps1",
    "外部文件"
  ],
  [
    "node \"$taskScript.js\"",
    "执行命令",
    "node",
    null
  ],
  [
    "pwsh -ExecutionPolicy Bypass -File scripts/audit.ps1",
    "运行脚本",
    "scripts/audit.ps1",
    "pwsh"
  ],
  [
    "node --eval=\"console.log(1)\"",
    "执行代码",
    "Node.js",
    null
  ],
  [
    "bash -lc \"echo private.sh\"",
    "执行代码",
    "Shell",
    null
  ],
  [
    "python -c\"print(1)\"",
    "执行代码",
    "Python",
    null
  ],
  [
    'node scripts/check.mjs --payload ' + 'x'.repeat(5000),
    "运行脚本",
    "scripts/check.mjs",
    "node"
  ]
];
  for(const [command,title,identity,hint] of cases){
    const node=presentFlowStep(step('review','commandExecution',{command}),project);
    assert.equal(node.title,title,command); assert.equal(node.subtitle,identity,command); assert.equal(node.hint??null,hint,command);
    assert(!JSON.stringify([node.title,node.subtitle,node.hint]).includes('private'));
  }
});

test('实际MCP服务器和只读元数据用于分类，未描述动作的工具不冒充未知事件或写操作', () => {
  const node=presentFlowStep(step('actual','mcpToolCall',{server:'xinshu',tool:'some_provider.inspect',readOnlyHint:true}),project);
  assert.equal(node.source,'xinshu · MCP'); assert.equal(node.category,'reading');
  const unknown=presentFlowStep(step('typed','mcpToolCall',{server:'xinshu',tool:'some_provider.run',readOnlyHint:false}),project);
  assert.equal(unknown.category,'tooling');
  const remotePath=presentFlowStep(step('remote','mcpToolCall',{server:'remote',tool:'read_file',arguments:{path:'D:/work/relay/a.ts'}}),project);
  assert.equal(remotePath.resource.group.id,'remote-files:remote');
  assert.equal(remotePath.subtitle,'read_file'); assert.equal(remotePath.hint,'a.ts');
  const remoteEdit=presentFlowStep(step('remote-edit','mcpToolCall',{server:'remote',tool:'edit_file',arguments:{path:'D:/work/relay/a.ts'}}),project);
  assert.equal(remoteEdit.subtitle,'edit_file'); assert.equal(remoteEdit.hint,'a.ts');
});

test('实际多命令技能路径不吞入前面的管道，外部项目技能和工作目录归属可说明', () => {
  const command='Get-Content ai/standards/rules.md | Select-Object -First 8; Get-Content ai/skills/readonly-db/SKILL.md';
  const node=presentFlowStep(step('multi-read','commandExecution',{command,cwd:'D:/work/relay'}),project);
  assert.equal(node.title,'读取技能'); assert.equal(node.subtitle,'readonly-db'); assert.match(node.hint,/工作区技能/); assert.equal(node.source,'终端');
  assert(!node.resource.id.includes('|')); assert(!node.resource.id.includes(';'));
  const external=presentFlowStep(step('external-skill','commandExecution',{command:'Get-Content doc/ai/skills/common/review/SKILL.md',cwd:'D:/external/service'}),{...project,knownProjects:[{path:'D:/external/service',name:'服务项目'}]});
  assert.equal(external.source,'终端'); assert.match(external.hint,/工作区技能/); assert.equal(external.resource.group.label,'服务项目');
  const directory=presentFlowStep(step('cwd','commandExecution',{command:'node task.mjs',cwd:'D:/external/utility'}),project);
  assert.equal(directory.resource.group.id,'directory:d:/external/utility');
  assert.equal(directory.resource.group.label,'目录 · utility');
});

test('来源名称不暗示服务不可用或工具属于系统，Git与其他命令行统一归组', () => {
  assert.equal(getFlowSourceLabel('服务未提供 · MCP'),'MCP 工具（来源未记录）');
  assert.equal(getFlowSourceLabel('内置工具'),'内置工具');
  assert.equal(getFlowSourceLabel('系统'),'引擎');
  const nodes=[presentFlowStep(step('git','commandExecution',{command:'git status'}),project),presentFlowStep(step('shell','commandExecution',{command:'node app.mjs'}),project)];
  const groups=groupFlowNodes(nodes,'category','tool');
  assert.equal(groups.length,1); assert.equal(groups[0].title,'终端'); assert.equal(groups[0].nodes.length,2);
  const mcp=presentFlowStep(step('mcp-unknown','mcpToolCall',{tool:'read_resource'}),project);
  assert.match(groupFlowNodes([mcp],'category','tool')[0].title,/MCP 工具（来源未记录）/);
  assert(!groupFlowNodes([mcp],'category','resource')[0].title.includes('服务未提供'));
});

test('异步问题等待回答不等同于本轮执行未确认，已关联回答后完成', () => {
  const question=step('async-question:q','interaction',{interactionKind:'async_question',questions:[{title:'是否沿用？'}]},'in_progress');
  assert.equal(getFlowStepState(question,'completed'),'waiting');
  const context=captureProcessFlow(null,input({steps:[question]}));
  const nodes=buildFlowNodes(context,[question],[],{outcome:'completed',answeredIds:new Set([question.id])});
  assert.equal(nodes.find(node=>node.id===question.id).state,'completed');
  assert.equal(getFlowStepState(step('approval','interaction',{interactionKind:'command_approval'},'in_progress'),'completed'),'unknown');
});

test('恢复补回的较早事件按首次记录时间归位，同一时间稳定排序，缺失时间保留原槽位', () => {
  const steps=[step('later','commandExecution',{command:'node later.mjs',firstObservedAt:900}),step('missing','imageView',{path:'a.png'}),step('early','userMessage',{text:'引擎输入',firstObservedAt:400}),step('same','commandExecution',{command:'node same.mjs',firstObservedAt:900})];
  const context=captureProcessFlow(null,input({steps,timeline:timeline(...steps.map(item=>item.id))}));
  const nodes=buildFlowNodes(context,steps,context.timeline,{streaming:true});
  assert.deepEqual(nodes.map(node=>node.id),['input:root','early','missing','later','same']);
  assert.deepEqual(nodes.map(node=>node.sequence),[1,2,3,4,5]);
  assert.equal(steps[0].id,'later');
});

test('跨项目读取显式worktree文件按路径中的仓库目录展示和归组，不冒认cwd项目', () => {
  const path='D:\\office\\projects\\xinshu-spider\\.worktrees\\feature--9001000001-ai-gateway-client\\src\\main\\java\\WinLossServiceClient.java';
  const node=presentFlowStep(step('external-read','commandExecution',{command:`Get-Content -Encoding UTF8 -LiteralPath '${path}' -TotalCount 180`,cwd:'D:/demo/workspace'}),project);
  assert.equal(node.title,'查看文件');
  assert.equal(node.subtitle,'WinLossServiceClient.java'); assert.match(node.hint,/前 180 行/); assert.match(node.hint,/项目：xinshu-spider/);
  assert.equal(node.resource.group.id,'project:d:/office/projects/xinshu-spider');
  assert.equal(node.resource.group.label,'xinshu-spider');
  const second=presentFlowStep(step('external-edit','fileChange',{path:path.replace('feature--9001000001-ai-gateway-client','another-branch')}),project);
  assert.equal(second.resource.group.id,node.resource.group.id);
});

test('worktree路径识别保持已登记项目名称优先，普通目录不猜仓库', () => {
  const path='/repos/service/.worktrees/branch/src/main.ts';
  const known=presentFlowStep(step('known-tree','fileChange',{path}),{...project,knownProjects:[{path:'/repos/service',name:'服务项目'}]});
  assert.equal(known.subtitle,'main.ts'); assert.match(known.hint,/项目：服务项目/);
  const plain=presentFlowStep(step('plain','fileChange',{path:'/repos/service/src/main.ts'}),project);
  assert.equal(plain.subtitle,'main.ts'); assert.equal(plain.hint,'外部文件');
});

test('完成消息可恢复流程，上下文按消息隔离并仅复用同会话UI', () => {
  const messages=[message('root'),message('answer','user','t1',{replyToAsyncQuestionId:'q'}),message('done','assistant','t1',{outcome:'completed',phase:'final_answer'}),message('next','assistant','t2',{outcome:'completed',phase:'final_answer'})];
  const first=buildCompletedFlows(messages,new Map(),project);
  assert.equal(first.get('done').root.id,'input:root'); assert.equal(first.get('done').inputs[0].kind,'answer');
  first.get('done').ui.view='category'; first.get('done').ui.panelExpanded=true;
  const loaded=buildCompletedFlows(messages.map(m=>m.id==='done'?{...m,items:[step('read')]}:m),first,project);
  assert.equal(loaded.get('done').ui.view,'category'); assert.equal(loaded.get('next').ui.view,undefined);
  assert.equal(loaded.get('done').steps.length,1); assert.equal(loaded.get('done').inputs[0].positionKnown,false);
  assert.equal(loaded.get('next').root.positionKnown,false);
  const switched=buildCompletedFlows(messages.map(m=>({...m,session_id:'s2'})),first,project);
  assert.equal(switched.get('done').ui.view,undefined);
});

test('完成流程用明确请求回合恢复输入，保留同引擎回合补充输入且不跨会话猜配', () => {
  const messages=[message('root','user','relay-request'),message('steer','user','engine-turn'),message('done','assistant','engine-turn',{requestTurnId:'relay-request'}),message('foreign','user','relay-request',{session_id:'other'})];
  const flow=buildCompletedFlows(messages,new Map(),project).get('done');
  assert.equal(flow.root.id,'input:root'); assert.deepEqual(flow.inputs.map(input=>input.id),['input:steer']);
  const nodes=buildFlowNodes(flow,[],[],{streaming:false});
  assert.equal(nodes.filter(node=>node.category==='input').length,2); assert(!nodes.some(node=>node.id.startsWith('missing:')));
  assert(buildCompletedFlows([messages[2],messages[3]],new Map(),project).get('done').root.id.startsWith('missing:'));
  const partial=buildCompletedFlows(messages.slice(1),new Map(),project).get('done');
  assert(partial.root.id.startsWith('missing:')); assert.equal(partial.inputs[0].id,'input:steer');
  assert.equal(captureProcessFlow(null,input({messages})),null);
  assert.equal(getFlowCompletionMessage({...flow,turnId:'relay-request'},messages).id,'done');
});

test('框选卡片文字不触发展开，外部选区和折叠光标不阻止普通点击', () => {
  const inside={},outside={},container={contains:node=>node===inside};
  assert(hasFlowTextSelection({isCollapsed:false,anchorNode:inside,focusNode:outside},container));
  assert(!hasFlowTextSelection({isCollapsed:true,anchorNode:inside,focusNode:inside},container));
  assert(!hasFlowTextSelection({isCollapsed:false,anchorNode:outside,focusNode:outside},container));
  assert(!hasFlowTextSelection(null,container));
});

test('完成流程不把交互问题记录当最终回复，也不跨会话或空turn拼接输入', () => {
  const flows=buildCompletedFlows([message('wrong','user','t1',{session_id:'s2'}),message('orphan','user',''),message('question','assistant','t1',{phase:'interaction'}),message('done','assistant','t1',{phase:'final_answer'}),message('legacy','assistant','')],new Map(),project);
  assert(!flows.has('question')); assert.equal(flows.get('done').root.positionKnown,false);
  assert.equal(flows.get('legacy').root.positionKnown,false);
  assert.equal(buildCompletedFlows([message('cb','assistant','t1',{modelInfo:{engineId:'codebuddy'}})],new Map(),project).size,0);
});

test('项目资源区分同名仓库、跨项目操作和非文件来源，单个事件不重复计数', () => {
  const context={...project,knownProjects:[{path:'D:/repo/a',name:'服务'},{path:'D:/repo/b',name:'服务'}]};
  const nodes=[
    presentFlowStep(step('a','fileChange',{path:'D:/repo/a/main.ts'}),context),
    presentFlowStep(step('b','fileChange',{path:'D:/repo/b/main.ts'}),context),
    presentFlowStep(step('cross','fileChange',{changes:[{path:'D:/repo/a/a.ts'},{path:'D:/repo/b/b.ts'}]}),context),
    presentFlowStep(step('web','webSearch',{query:'资料'}),context),
    presentFlowStep(step('mcp','mcpToolCall',{server:'Figma',tool:'get_design_context'}),context),
    presentFlowStep(step('plan','plan',{plan:[]}),context),
    presentFlowStep(step('test','commandExecution',{command:'npm test',cwd:'D:/repo/a'}),context),
  ];
  const groups=groupFlowNodes(nodes,'category','resource');
  assert.equal(groups.filter(group=>group.title==='服务').length,2);
  assert.equal(groups.find(group=>group.nodes.some(node=>node.id==='test')).nodes.length,2);
  assert(groups.some(group=>group.title==='跨项目操作'));
  assert.deepEqual(groups.find(group=>group.title==='Relay').nodes.map(node=>node.id),['web','mcp','plan']);
  assert(!groups.some(group=>group.title==='Figma · MCP' || group.title==='分析与计划'));
  assert.equal(groups.flatMap(group=>group.nodes).length,nodes.length);
  assert(!groups.some(group=>/未指定资源|多资源操作/.test(group.title)));
  const externalEdit=presentFlowStep(step('external-edit','dynamicToolCall',{tool:'edit_file',arguments:{path:'main.ts',workdir:'D:/repo/b'}}),context);
  assert.equal(externalEdit.resource.group.id,'project:d:/repo/b');
});

test('同ID助手说明先到时仍保留后到的原生证据', () => {
  const context=captureProcessFlow(null,input());
  const native=step('progress','agentMessage',{text:'正在检查'});
  const nodes=buildFlowNodes(context,[native],[{type:'narrative',itemId:'progress',content:'正在检查'}],{streaming:true});
  assert.equal(nodes.filter(node=>node.id==='progress').length,1);
  assert.equal(nodes.find(node=>node.id==='progress').step,native);
});

test('结束快照不丢本页已观察到的原生事件，完成回执更新结果但不重排首次记录', () => {
  const live=[step('image','imageView',{path:'D:/work/relay/a.png'}),step('run','commandExecution',{command:'node app.mjs'},'in_progress')];
  const context=captureProcessFlow(null,input({steps:live,timeline:timeline('image','run')}));
  const nodes=buildFlowNodes(context,[step('run','commandExecution',{command:'node app.mjs'},'completed')],timeline('run'),{streaming:false});
  assert.deepEqual(nodes.slice(1,-1).map(node=>node.id),['image','run']);
  assert.equal(nodes.find(node=>node.id==='run').state,'completed');
});

test('内容去重保留代码空白语义，不把不同缩进的原生输入合并', () => {
  const context=captureProcessFlow(null,input({messages:[message('root','user','t1',{content:'if ready:\n  run()'})]}));
  const native=step('different','userMessage',{text:'if ready: run()'});
  assert(buildFlowNodes(context,[native],[],{streaming:true}).some(node=>node.id==='different'));
});

test('原生用户回声合并到输入卡片并保留原始证据，未匹配原生消息仍可读', () => {
  const attachment={id:'image',kind:'uploaded_file',name:'参考.png',path:'D:/upload/image.png',mimeType:'image/png',size:100,available:true};
  const context=captureProcessFlow(null,input({messages:[message('root','user','t1',{content:'再次整体核查检查下修改内容，是否有遗漏',attachments:[attachment]})]}));
  const echo=step('native','userMessage',{content:[{type:'text',text:context.root.content,text_elements:[]}]});
  const another=step('extra','userMessage',{content:[{type:'text',text:'引擎侧额外输入'}]});
  const nodes=buildFlowNodes(context,[echo,another],timeline('native','extra'),{streaming:true});
  assert.equal(nodes.filter(node=>node.text===context.root.content).length,1);
  assert.equal(nodes[0].step.id,'native'); assert.deepEqual(nodes[0].attachments,[attachment]);
  assert.equal(nodes.find(node=>node.id==='extra').category,'input');
  assert.equal(nodes.find(node=>node.id==='extra').text,'引擎侧额外输入');
});

test('原生助手消息与进度最终回复或派生问题合并，不增加重复节点', () => {
  const context=captureProcessFlow(null,input());
  const steps=[step('native','agentMessage',{content:[{type:'text',text:'正在检查'}]}),step('final','agentMessage',{text:'已完成'}),step('ask','agentMessage',{text:'请选择'}),step('question','interaction',{sourceItemId:'ask',interactionKind:'async_question'})];
  const nodes=buildFlowNodes(context,steps,[{type:'narrative',itemId:'progress',content:'正在检查'}],{streaming:false,finalContent:'已完成'});
  assert.equal(nodes.filter(node=>node.text==='正在检查').length,1);
  assert.equal(nodes.filter(node=>node.text==='已完成').length,1);
  assert.equal(nodes.at(-1).step.id,'final'); assert(!nodes.some(node=>node.id==='ask'));
});

test('协议声明的原生事件均有友好分类', () => {
  for(const type of ['userMessage','agentMessage','reasoning','commandExecution','fileChange','collabAgentToolCall','subAgentActivity','webSearch','imageGeneration','imageView','plan','mcpToolCall','dynamicToolCall','hookPrompt','sleep','contextCompaction','enteredReviewMode','exitedReviewMode']) {
    const node=presentFlowStep(step(type,type,{content:[{type:'text',text:'消息'}]}),project);
    if (!['mcpToolCall','dynamicToolCall'].includes(type)) assert.notEqual(node.category,'other',type);
    assert(!node.title.includes('未识别'),type);
  }
});

test('补充消息被队列状态更新时仍保留附件', () => {
  const attachments=[{id:'doc',kind:'host_file',name:'需求.pdf',path:'D:/需求.pdf',size:20}];
  const first=captureProcessFlow(null,input());
  const context=captureProcessFlow(first,input({messages:[message('root'),message('supplement','user','t1',{attachments})],followups:[followup('supplement')]}));
  assert.deepEqual(context.inputs[0].attachments,attachments);
});

test('交互记录不提前结束本轮，回答继续纳入流程，最新空正文中断不被进度说明盖过', () => {
  const root=message('root');
  const question=step('q','interaction',{title:'选择方案',interactionKind:'async_question'},'in_progress');
  const record=message('prompt','assistant','t1',{phase:'interaction',content:'请选择方案',items:[question],outcome:'completed'});
  const initial=captureProcessFlow(null,input({messages:[root]}));
  const live=captureProcessFlow(initial,input({messages:[root,record,message('answer','user','t1',{replyToAsyncQuestionId:'q'})],steps:[question],timeline:timeline('q')}));
  assert(live); assert.equal(live.inputs.length,1); assert.equal(live.inputs[0].kind,'answer');
  assert.equal(getFlowCompletionMessage(live,[record]),undefined);
  const interrupted=message('interrupted','assistant','t1',{phase:'final_answer',content:'',outcome:'interrupted'});
  assert.equal(getFlowCompletionMessage(live,[record,interrupted]).id,'interrupted');
});

test('意外中断不能冒认为回复已完成，缺少终态的操作仍为结果未确认', () => {
  const context=captureProcessFlow(null,input());
  const nodes=buildFlowNodes(context,[step('run','commandExecution',{command:'node job.mjs'},'in_progress')],[],{streaming:false,outcome:'interrupted'});
  assert.equal(nodes.at(-1).title,'交付回复'); assert.equal(nodes.at(-1).state,'unknown');
  assert.equal(nodes.find(node=>node.id==='run').state,'unknown'); assert(!nodes.some(node=>node.title==='本次回复已完成'));
  assert.equal(getFlowStepState(step('bad','commandExecution',{exitCode:1},'in_progress')),'failed');
  assert.equal(getFlowStepState(step('error','commandExecution',{errorCode:'EXEC_FAILED'},'in_progress')),'failed');
});

test('MCP URI不冒认本地项目文件，也不把URI参数放进资源分组标识', () => {
  const node=presentFlowStep(step('uri','mcpToolCall',{tool:'read_resource',arguments:{path:'skill://team/demo/SKILL.md?key=private'}}),project);
  assert.equal(node.subtitle,'read_resource'); assert.match(node.hint,/MCP 资源/); assert(!node.subtitle.includes('Relay')); assert(!node.subtitle.includes('private'));
  assert.equal(node.resource.id,'uri'); assert(!node.resource.id.includes('private'));
  const file=presentFlowStep(step('colon','fileChange',{path:'/tmp/a:b.ts'}),project);
  assert.notEqual(file.resource.id,'uri');
});

test('超长命令使用保守摘要，完整原始命令仍可查看', () => {
  const command='powershell -EncodedCommand '+ 'A'.repeat(100_000);
  const node=presentFlowStep(step('long','commandExecution',{command}),project);
  assert.equal(node.title,'执行代码'); assert.equal(node.hint,undefined); assert.equal(node.subtitle,'PowerShell'); assert.equal(node.step.details.command,command);
});

test('三种分类只改变分组，不复制遗漏事件或改变时间流', () => {
  const context=captureProcessFlow(null,input());
  const nodes=buildFlowNodes(context,[step('read','commandExecution',{command:'cat src/a.ts'}),step('edit','fileChange',{path:'src/a.ts'})],[],{streaming:true});
  for(const mode of ['action','tool','resource']){
    const groups=groupFlowNodes(nodes,'category',mode);
    assert.deepEqual(groups.flatMap(group=>group.nodes.map(node=>node.id)).sort(),nodes.map(node=>node.id).sort());
    assert.deepEqual(groupFlowNodes(nodes,'time',mode),groupFlowNodes(nodes,'time'));
  }
});

test('同项目不同文件归一组，文件身份仍保持独立且POSIX大小写保留', () => {
  const a=presentFlowStep(step('a','commandExecution',{command:'cat src/a.ts'}),project);
  const edit=presentFlowStep(step('edit','fileChange',{path:'D:/work/relay/src/a.ts'}),project);
  const b=presentFlowStep(step('b','fileChange',{path:'tests/a.ts'}),project);
  const groups=groupFlowNodes([a,edit,b],'category','resource');
  assert.equal(groups.length,1); assert.equal(groups[0].nodes.length,3); assert.equal(groups[0].title,'Relay');
  assert.notEqual(a.resource.id,b.resource.id);
  const unix=[presentFlowStep(step('upper','fileChange',{path:'/tmp/A.ts'}),{}),presentFlowStep(step('lower','fileChange',{path:'/tmp/a.ts'}),{})];
  assert.notEqual(unix[0].resource.id,unix[1].resource.id);
  assert.equal(groupFlowNodes(unix,'category','resource')[0].title,'未匹配项目的文件');
});

test('多文件操作只出现一次，文件变更按实际cwd解析，技能归到明确资源', () => {
  const multi=presentFlowStep(step('multi','fileChange',{changes:[{path:'a.ts'},{path:'b.ts'}]}),project);
  assert.equal(multi.resource.label,'多文件操作'); assert.equal(groupFlowNodes([multi],'category','resource')[0].nodes.length,1);
  assert.equal(groupFlowNodes([multi],'category','resource')[0].title,'Relay');
  const external=presentFlowStep(step('external','fileChange',{path:'src/a.ts',cwd:'D:/other'}),project);
  assert.match(external.resource.id,/d:\/other\/src\/a.ts/); assert.equal(external.subtitle,'a.ts'); assert.match(external.hint,/目录|外部/);
  const skill=presentFlowStep(step('skill','commandExecution',{command:'cat ai/skills/review/SKILL.md'}),project);
  assert.equal(skill.resource.label,'技能：review');
});

test('按提供方分组合并同服务的不同函数，仍合并同一终端来源', () => {
  const tools=['meta_data.search','ddl_request.list'].map(tool=>presentFlowStep(step(tool,'mcpToolCall',{tool}),project));
  const groups=groupFlowNodes(tools,'category','tool'); assert.equal(groups.length,1); assert.equal(groups[0].title,'MCP 工具（来源未记录）');
  const commands=['cat a.ts','node job.mjs'].map(command=>presentFlowStep(step(command,'commandExecution',{command}),project));
  assert.equal(groupFlowNodes(commands,'category','tool').length,1);
});

test('搜索展示关键词与范围，查看文件支持无扩展名并排除编码和行号参数', () => {
  for (const command of ["rg -n -g '*.ts' -A 4 'turn_id' client/src", "rtk rg -n 'turn_id' client/src", "Select-String -Pattern 'turn_id' -Path client/src/chat.ts"]) {
    const node=presentFlowStep(step(command,'commandExecution',{command}),project);
    assert.equal(node.category,'reading'); assert.equal(node.subtitle,'turn_id'); assert.match(node.hint,/范围：(src|chat\.ts)/); assert(!node.subtitle.includes('client/'));
  }
  const search=presentFlowStep(step('search','commandExecution',{command:'node ai/scripts/search.mjs code "flow state"'}),project);
  assert.equal(search.subtitle,'flow state'); assert(!search.subtitle.includes('search.mjs'));
  const compound=presentFlowStep(step('compound','commandExecution',{command:'rg -n "foo | bar" src | Select-Object -First 10'}),project);
  assert.equal(compound.subtitle,'foo | bar'); assert(!compound.subtitle.includes('Select-Object'));
  const files=presentFlowStep(step('files','commandExecution',{command:'rg --files client'}),project);
  assert.equal(files.subtitle,'文件列表'); assert.match(files.hint,/范围：client/);
  const read=presentFlowStep(step('read','commandExecution',{command:'Get-Content -Encoding utf8 -LiteralPath "client/My File" | Select-Object -Skip 12 -First 20'}),project);
  assert.equal(read.subtitle,'client/My File'); assert.equal(read.hint,'第 13～32 行');
  assert.equal(presentFlowStep(step('license','commandExecution',{command:'cat LICENSE'}),project).subtitle,'LICENSE');
});

test('读取摘要区分前后行、指定区间、整段文本和复杂筛选', () => {
  for (const [command, range] of [
    ['Get-Content app.ts -TotalCount 30','前 30 行'],
    ['Get-Content app.ts -Tail 20','最后 20 行'],
    ['Get-Content app.ts | Select-Object -Skip 10 -First 20','第 11～30 行'],
    ['Get-Content app.ts -TotalCount 20 | Select-Object -Skip 10 -First 20','第 11～20 行'],
    ['Get-Content app.ts | Select-Object -Last 10','最后 10 行'],
    ['Get-Content app.ts -Tail 30 | Select-Object -Skip 5 -First 10','最后 30 行中跳过 5 行，读取 10 行'],
    ['Get-Content -Raw app.ts | Select-Object -First 10','整段文本'],
    ['Get-Content app.ts -ReadCount 10 | Select-Object -First 2','按命令指定格式读取'],
    ['Get-Content app.ts | Select-Object -First 2 -Last 3','部分内容（按命令筛选）'],
    ['Get-Content app.ts | Where-Object { $_ } | Select-Object -First 10','部分内容（按命令筛选）'],
    ['Get-Content app.ts | Select-Object -First 0','请求读取 0 行'],
  ]) assert.equal(describeReadRange(command),range);
  assert.equal(describeReadRange('Get-Content app.ts'),undefined);
});

test('节点摘要包含实际输入和数组思考内容，文件增删不误称修改', () => {
  const context=captureProcessFlow(null,input());
  context.root.content='检查流程布局';
  assert.match(buildFlowNodes(context,[],[],{streaming:true})[0].subtitle,/检查流程布局/);
  const thought=presentFlowStep(step('thought','reasoning',{summary:[{text:'核查布局与状态'}]}),project);
  assert.equal(thought.subtitle,'核查布局与状态');
  const change=presentFlowStep(step('deleted','fileChange',{path:'old.ts',changeType:'delete'}),project);
  assert(!change.title.includes('修改'));
  assert.equal(presentFlowStep(step('web','webSearch',{content:'组件兼容性'}),project).subtitle,'组件兼容性');
});

test('输入观察锚点不再存在时保留内容并移除顺序连线', () => {
  const context=captureProcessFlow(null,input());
  context.inputs=[{id:'extra',content:'补充要求',label:'用户补充要求',delivery:'已送入当前执行',state:'completed',positionKnown:true,afterItemId:'hidden-event'}];
  const node=buildFlowNodes(context,[],[],{streaming:true}).find(node=>node.id==='extra');
  assert.equal(node.positionKnown,false); assert.match(node.subtitle,/补充要求/); assert.match(node.hint,/具体发生位置未记录/);
});

test('实时补充插入可见步骤之后，不因末尾空思考或空说明掉到流程末尾', () => {
  const visible=step('read','commandExecution',{command:'cat README.md'});
  const hidden=step('empty','reasoning',{},'in_progress');
  const initial=captureProcessFlow(null,input({steps:[visible],timeline:timeline('read')}));
  const observed=captureProcessFlow(initial,input({messages:[message('root'),message('extra')],steps:[visible,hidden],timeline:[...timeline('read','empty'),{type:'narrative',itemId:'blank',content:''}]}));
  assert.equal(observed.inputs[0].afterItemId,'read');
  const later=step('later','commandExecution',{command:'node check.mjs'});
  const nodes=buildFlowNodes(observed,[visible,later],timeline('read','later'),{streaming:true});
  assert.deepEqual(nodes.map(node=>node.id),['input:root','read','input:extra','later']);
  assert.equal(nodes[2].positionKnown,true);
});

test('实际历史中的点分MCP工具可归类，未知写操作不会误认读取', () => {
  for (const [tool,category,title] of [
    ['ddl_request.submit','execution','提交 DDL 工单'],['ddl_request.detail','reading','查看 DDL 工单'],['ddl_request.list','reading','查询 DDL 工单'],
    ['meta_data.search','reading','搜索元数据'],['meta_data.instance_capacity','reading','查看实例容量'],['structure_standard.evaluate_ddl','execution','校验 DDL 规范'],['structure_standard.rules','reading','读取结构规范'],
  ]) {
    const node=presentFlowStep(step(tool,'mcpToolCall',{tool,arguments:{query:'users'}}),project);
    assert.equal(node.category,category); assert.equal(node.title,title);
    assert.equal(Boolean(node.hint?.includes('users')), /search|list|discovery/i.test(tool));
  }
  assert.equal(presentFlowStep(step('new','mcpToolCall',{tool:'new_service.delete_widget'}),project).category,'tooling');
});

test('流程结束缺省终态也收敛运行中节点，不能把未知结果强制当成功', () => {
  const context=captureProcessFlow(null,input());
  const items=[step('a','commandExecution',{},'in_progress'),step('q','interaction',{resolvedAction:'accept'},'in_progress'),step('agent','collabAgentToolCall',{agentResults:[{threadId:'a',status:'running'}]})];
  const nodes=buildFlowNodes(context,items,[],{streaming:false});
  assert.equal(nodes.find(node=>node.id==='a').state,'unknown');
  assert.equal(nodes.find(node=>node.id==='a').subtitle,'命令身份未记录');
  assert.match(nodes.find(node=>node.id==='a').hint,/执行已结束/);
  assert.equal(nodes.find(node=>node.id==='q').state,'completed');
  assert.equal(nodes.find(node=>node.id==='agent').children[0].state,'unknown');
  assert(!nodes.some(node=>node.state==='running'));
  assert.equal(getFlowStepState(step('denied','interaction',{resolvedAction:'decline'},'in_progress')),'stopped');
  // The interaction record is resolved; this does not invent an accept/submit decision.
  const elsewhere=presentFlowStep(step('elsewhere-record','interaction',{resolvedAction:'resolved_elsewhere'},'in_progress'),project);
  assert.equal(elsewhere.state,'completed'); assert.equal(elsewhere.title,'请求授权'); assert.equal(getFlowStatusLabel(elsewhere),'已处理');
  assert.equal(elsewhere.step.details.resolvedAction,'resolved_elsewhere');
  assert.equal(getFlowStepState(step('unknown','interaction',{resolvedAction:'future_action'},'in_progress')),'unknown');
});

test('计划事件只是已收到的快照，不显示为仍在执行的操作', () => {
  const node=presentFlowStep(step('plan','plan',{plan:[{step:'check',status:'inProgress'}]},'in_progress'),project);
  assert.equal(node.state,'completed'); assert.match(node.subtitle,/最新进度见底部/);
});

test('同一节点的多次状态快照保留最新结果，不能把旧运行态当并发', () => {
  const context=captureProcessFlow(null,input());
  const nodes=buildFlowNodes(context,[step('same','commandExecution',{command:'cat README.md'},'in_progress'),step('same','commandExecution',{command:'cat README.md'},'completed')],[],{streaming:true});
  assert.equal(nodes.filter(node=>node.id==='same').length,1);
  assert.equal(nodes.find(node=>node.id==='same').state,'completed');
});

test('命令和工具名称不把参数文本误认为动作，未知状态不声称完成', () => {
  for (const command of ['git diff ai/skills/demo/SKILL.md', 'Remove-Item ai/skills/demo/SKILL.md', 'echo "cat README.md"', 'echo "git push"']) {
    const node = presentFlowStep(step(command, 'commandExecution', { command }), project);
    assert(!node.title.startsWith('读取技能')); assert.notEqual(node.title, '查看文件'); assert.notEqual(node.title, '推送代码'); assert(!node.title.startsWith('运行脚本'));
  }
  assert.equal(presentFlowStep(step('delete', 'mcpToolCall', { tool: 'delete_widget' }), project).category, 'tooling');
  assert.equal(getFlowStepState(step('future', 'future', {}, 'future_status')), 'unknown');
  assert.equal(presentFlowStep(step('agents', 'collabAgentToolCall', { agentResults: [{ threadId: 'a' }] }), project).children[0].state, 'unknown');
});

test('回答覆盖只影响本次图，不污染原始节点缓存', () => {
  const question = step('q', 'interaction', {}, 'in_progress');
  const context = captureProcessFlow(null, input());
  assert.equal(buildFlowNodes(context, [question], [], { answeredIds: new Set(['q']) }).find(node => node.id === 'q').state, 'completed');
  assert.equal(presentFlowStep(question, project).state, 'waiting');
});

test('本地回答标记不覆盖明确失败或已记录决策，保留真实终态', () => {
  const context=captureProcessFlow(null,input());
  for(const [id,status,details,state,label] of [
    ['failed','incomplete',{},'failed','失败'],
    ['failed-decision','completed',{resolvedAction:'accept',errorCode:'FAILED'},'failed','失败'],
    ['declined','completed',{resolvedAction:'decline'},'stopped','已拒绝'],
    ['cancelled','completed',{resolvedAction:'cancel'},'stopped','已取消'],
    ['elsewhere','completed',{resolvedAction:'resolved_elsewhere'},'completed','已处理'],
  ]) {
    const question=step(id,'interaction',{interactionKind:'async_question',...details},status);
    const node=buildFlowNodes(context,[question],[],{answeredIds:new Set([id])}).find(node=>node.id===id);
    assert.equal(node.state,state,id); assert.equal(getFlowStatusLabel(node),label,id);
    assert.equal(question.status,status);
  }
});

test('结束说明进入补充行，原生消息分支只显示动作标题', () => {
  const context=captureProcessFlow(null,input());
  const command=step('unfinished','commandExecution',{command:'node scripts/check.mjs'},'in_progress');
  const node=buildFlowNodes(context,[command],[],{outcome:'completed'}).find(node=>node.id===command.id);
  assert.equal(node.subtitle,'scripts/check.mjs');
  assert.equal(node.hint,'node · 本次执行已结束，此步骤结果未确认');
  assert.equal(presentFlowStep(step('user-native','userMessage',{text:'补充要求'}),project).title,'输入记录');
  assert.equal(presentFlowStep(step('assistant-native','agentMessage',{text:'检查中'}),project).title,'说明进度');
});

test('待发送补充不冒认新流程，审计记录不提前结束流程，正式投递后开启新轮', () => {
  const messages = [message('old'), message('done', 'assistant'), message('queued', 'user', 't2')];
  assert.equal(captureProcessFlow(null, input({ messages, followups: [followup('queued', 'queued')] })), null);
  const next = captureProcessFlow(null, input({ messages, followups: [followup('queued', 'delivered')] }));
  assert.equal(next.root.id, 'input:queued');
  const audit = message('audit', 'assistant', 't1', { content: '', phase: 'interaction', items: [step('q', 'interaction')] });
  const current = captureProcessFlow(null, input({ messages: [message('root'), audit] }));
  assert(current); assert.equal(getFlowCompletionMessage(current, [audit]), undefined);
});

test('Skill 默认展示可确认名称和系统、个人、工作区、插件来源，不声称执行', () => {
  for (const [path, source] of [
    ['C:/Users/a/.codex/skills/.system/pdf/SKILL.md', '系统技能'],
    ['C:/Users/a/.agents/skills/research/SKILL.md', '个人技能'],
    ['D:/work/relay/ai/skills/acceptance/SKILL.md', '工作区技能'],
    ['C:/Users/a/.codex/plugins/cache/tool/font/SKILL.md', '插件技能'],
  ]) {
    const node = presentFlowStep(step('skill', 'commandExecution', { command: `Get-Content -Encoding utf8 -LiteralPath "${path}"` }), project);
    assert.equal(node.source, '终端'); assert.match(node.hint, new RegExp(source)); assert.equal(node.title, '读取技能'); assert(!node.title.includes('使用'));
  }
});

test('代码摘要只展示项目和文件名，外部路径不冒认当前项目，详情保留路径', () => {
  const inside = presentFlowStep(step('a', 'commandExecution', { command: 'Get-Content -LiteralPath D:/work/relay/client/src/app.tsx' }), project);
  assert.equal(inside.subtitle, 'client/src/app.tsx'); assert.equal(inside.hint,undefined);
  assert.match(inside.step.details.command,/client\/src\/app\.tsx/);
  const outside = presentFlowStep(step('b', 'fileChange', { changes: [{ path: 'D:/work/relay-other/app.tsx' }] }), project);
  assert.equal(outside.subtitle, 'app.tsx'); assert.equal(outside.hint,'外部文件');
  const elsewhere = presentFlowStep(step('c', 'commandExecution', { command: 'cat src/main.ts', cwd: 'D:/other' }), project);
  assert.equal(elsewhere.subtitle, 'main.ts'); assert.match(elsewhere.hint,/目录/);
  const escaped = presentFlowStep(step('d', 'fileChange', { changes: [{ path: '../relay-other/main.ts' }] }), project);
  assert.equal(escaped.subtitle, 'main.ts'); assert.equal(escaped.hint,'外部文件');
});

test('跨项目读取和文件变更显示已知项目及文件名，优先最具体项目根', () => {
  const knownProjects = [{ name: 'Service', path: 'D:/other' }, { name: 'Nested', path: 'D:/other/sub' }];
  const context = { ...project, knownProjects };
  const command = step('external', 'commandExecution', { command: 'Get-Content -LiteralPath D:/other/src/main.ts' });
  assert.equal(presentFlowStep(command, context).subtitle, 'main.ts'); assert.match(presentFlowStep(command,context).hint,/项目：Service/);
  assert.equal(presentFlowStep(step('nested', 'fileChange', { path: 'D:/other/sub/src/app.ts' }), context).subtitle, 'app.ts');
  assert.equal(presentFlowStep(step('cwd', 'commandExecution', { command: 'cat src/main.ts', cwd: 'D:/other' }), context).subtitle, 'main.ts');
  assert.equal(presentFlowStep(step('sibling', 'fileChange', { path: 'D:/other-project/app.ts' }), context).subtitle, 'app.ts');
  assert.match(presentFlowStep(command, { ...project, knownProjects: [{ name: 'Renamed', path: 'D:/other' }] }).hint,/项目：Renamed/);
});

test('未登记目录显示外部标识与文件名，文件登记工具也给出资源摘要', () => {
  const context = { projectName: 'A', projectPath: 'D:/office/projects/A' };
  const read = step('read', 'commandExecution', { command: 'Get-Content "D:\\\\office\\\\projects\\\\B\\\\AGENTS.md"', cwd: 'D:/office/projects/A' });
  assert.equal(presentFlowStep(read, context).subtitle, 'AGENTS.md');
  const report = step('report', 'dynamicToolCall', { tool: 'relay_report_file_changes', arguments: { reportedFileChanges: [{ path: 'D:/office/projects/B/report.md', changeType: 'modified' }] } });
  const node = presentFlowStep(report, context);
  assert.equal(node.category, 'execution'); assert.equal(node.title, '登记文件变更');
  assert.equal(node.subtitle, 'report.md');
  const unknown = presentFlowStep(step('newtool', 'dynamicToolCall', { tool: 'future_widget' }), context);
  assert.equal(unknown.title, '调用工具'); assert.match(unknown.subtitle, /future_widget/); assert.equal(unknown.category, 'tooling');
});

test('MCP 显示服务来源、工具与资源，参数保留在原始 step', () => {
  const original = step('mcp', 'mcpToolCall', { serverName: 'Figma', tool: 'get_design_context', arguments: { nodeId: '1:2' } });
  const node = presentFlowStep(original, project);
  assert.equal(node.source, 'Figma · MCP'); assert.equal(node.category, 'reading');
  assert.equal(node.subtitle, 'get_design_context'); assert.equal(node.hint,'设计节点 1:2'); assert.strictEqual(node.step, original);
});

test('命令根据明确动作展示测试、类型、Git，未知操作保守回退', () => {
  for (const [command, title] of [['node --test app.test.mjs', '运行测试'], ['npx tsc --noEmit', '检查代码类型'], ['rtk git diff --stat', '检查差异']]) {
    assert.equal(presentFlowStep(step(command, 'commandExecution', { command }), project).title, title);
  }
  assert.equal(presentFlowStep(step('new', 'future-tool'), project).category, 'other');
});

test('非零退出、未完成、运行中与流程终态分开判断', () => {
  assert.equal(getFlowStepState(step('bad', 'commandExecution', { exitCode: 1 })), 'failed');
  assert.equal(getFlowStepState(step('old', 'commandExecution', {}, 'incomplete')), 'failed');
  const running = step('run', 'commandExecution', {}, 'in_progress');
  assert.equal(getFlowStepState(running), 'running');
  assert.equal(getFlowStepState(running, 'stopped'), 'stopped');
  assert.equal(getFlowStepState(running, 'completed'), 'unknown');
});

test('自动授权不显示为用户手动批准，待授权与普通运行区分', () => {
  const approved = presentFlowStep(step('allow', 'interaction', { interactionKind: 'command_approval', decisionSource: 'project_trust' }), project);
  assert.equal(approved.title, '请求授权'); assert.equal(approved.source, '系统'); assert.match(approved.hint,/决策：项目规则/);
  assert.equal(getFlowStepState(step('pending', 'interaction', {}, 'in_progress')), 'waiting');
});

test('初次恢复不猜补充位置；本页新收到补充保留观察锚点', () => {
  const a = step('a'); const b = step('b');
  const first = captureProcessFlow(null, input({ steps: [a], timeline: timeline('a'), followups: [followup('existing')] }));
  assert.equal(first.inputs[0].positionKnown, false);
  const updated = captureProcessFlow(first, input({ steps: [a,b], timeline: timeline('a','b'), followups: [followup('existing'),followup('new')] }));
  assert.equal(updated.inputs[1].afterItemId, 'b'); assert.equal(updated.inputs[1].positionKnown, true);
  const later = captureProcessFlow(updated, input({ steps: [a,b,step('c')], timeline: timeline('a','b','c'), followups: [followup('existing'),followup('new')] }));
  assert.equal(later.inputs[1].afterItemId, 'b'); assert.strictEqual(later.ui, first.ui);
});

test('补充排队、取消和送达不冒充已采用', () => {
  assert.equal(makeFlowFollowup(followup('q', 'queued')).delivery, '等待下一轮处理');
  assert.equal(makeFlowFollowup(followup('u', 'uncertain')).state, 'unknown');
  assert.equal(makeFlowFollowup(followup('c', 'cancelled')).state, 'stopped');
  assert.equal(makeFlowFollowup(followup('s')).delivery, '已送入当前执行');
});

test('会话和回合明确隔离，不关联相邻但不同回合的消息', () => {
  const context = captureProcessFlow(null, input({ messages: [message('old','user','old'),message('reply','assistant','old'),message('root'),message('foreign','user','foreign',{session_id:'s2'})] }));
  assert.equal(context.id, 'root'); assert.equal(context.inputs.length, 0);
  assert.equal(getFlowCompletionMessage(context, [message('wrong','assistant','other')]), undefined);
  assert.equal(getFlowCompletionMessage(context, [message('done','assistant')]).id, 'done');
});

test('同一回合多条用户消息保持最初输入，回答不被选成根请求', () => {
  const context = captureProcessFlow(null, input({ messages: [message('root'),message('extra'),message('answer','user','t1',{replyToAsyncQuestionId:'question'})] }));
  assert.equal(context.id, 'root'); assert.equal(context.inputs.length, 2);
  assert.equal(context.inputs[1].kind, 'answer');
});

test('用户输入按首次、补充和回答分组，排队送达状态不改变输入用途', () => {
  const context=captureProcessFlow(null,input({messages:[message('root'),message('extra'),message('answer','user','t1',{replyToAsyncQuestionId:'q'})],followups:[followup('queued','queued')]}));
  const nodes=buildFlowNodes(context,[],[],{streaming:true});
  assert.equal(nodes.find(node=>node.id==='input:root').title,'首次输入');
  assert.equal(nodes.find(node=>node.id==='input:extra').title,'补充输入');
  assert.equal(nodes.find(node=>node.id==='input:answer').title,'回答问题');
  const queued=nodes.find(node=>node.id==='input:queued');assert.equal(queued.title,'补充输入');assert.equal(queued.statusLabel,'已排队');
  const groups=groupFlowCapabilities(nodes,'action');
  assert.deepEqual(groups.map(group=>[group.label,group.nodes.length]),[['首次输入',1],['补充输入',2],['回答问题',1]]);
  const answering={...context,root:makeFlowInput(message('resume','user','t1',{replyToAsyncQuestionId:'q'}),true),inputs:[]};
  assert.equal(buildFlowNodes(answering,[],[],{streaming:true})[0].title,'回答问题');
});

test('宿主前缀回声合并到明确输入，保留原始证据，不剥离用户自写标签', () => {
  const context=captureProcessFlow(null,input({messages:[message('root','user','t1',{content:'确认'})]}));
  const prefix='<relay_host_context>\n【宿主平台信息：由 Relay 自动附加，非用户输入】\n环境说明\n</relay_host_context>\n\n';
  const echo=step('host-echo','userMessage',{text:prefix+'确认'}),other=step('unknown-input','userMessage',{text:'<relay_host_context>用户自写</relay_host_context>\n确认'});
  const nodes=buildFlowNodes(context,[echo,other],[],{streaming:true});
  assert.equal(nodes.length,2);assert.equal(nodes[0].title,'首次输入');assert.equal(nodes[0].text,'确认');
  assert.equal(nodes[0].step,echo);assert.equal(nodes[0].step.details.text,prefix+'确认');
  assert.equal(nodes[1].title,'输入记录');assert.match(nodes[1].text,/用户自写/);
});

test('连续同文首次、补充和回答的回声分别关联到尚未匹配的输入', () => {
  const context=captureProcessFlow(null,input({messages:[message('root','user','t1',{content:'确认'}),message('extra','user','t1',{content:'确认'}),message('answer','user','t1',{content:'确认',replyToAsyncQuestionId:'q'})]}));
  const steps=[0,1,2].map(index=>step(`same-echo-${index}`,'userMessage',{text:'确认'}));
  const nodes=buildFlowNodes(context,steps,[],{streaming:true});
  assert.equal(nodes.length,3);
  for(const [index,id] of ['input:root','input:extra','input:answer'].entries())assert.equal(nodes.find(node=>node.id===id).step.id,`same-echo-${index}`);
  assert.deepEqual(nodes.map(node=>node.title),['首次输入','补充输入','回答问题']);
});

test('节点按记录顺序、锚点插入，重复 operation 引用去重', () => {
  const a = step('a'), b = step('b');
  const context = captureProcessFlow(captureProcessFlow(null, input()), input({ steps: [a,b], timeline: timeline('a','b'), followups: [followup('extra')] }));
  const nodes = buildFlowNodes(context, [a,b], timeline('a','a','b'), { streaming: true });
  assert.deepEqual(nodes.map(node => node.id), ['input:root','a','b','input:extra']);
  assert.deepEqual(nodes.map(node => node.sequence), [1,2,3,4]);
});

test('缺少补充锚点但有消息时间的恢复记录明确按记录时间排列', () => {
  const context = captureProcessFlow(null, input({ followups: [followup('old')] }));
  const nodes = buildFlowNodes(context, [], [], { streaming: true });
  assert.match(nodes[1].hint, /按消息记录时间排列/);
});

test('工具失败可保留在正常完成流程中；停止和异常保留各自终态', () => {
  const context = captureProcessFlow(null, input());
  const bad = step('bad', 'commandExecution', { exitCode: 1 });
  for (const [outcome, title] of [['completed','本次回复已完成'],['stopped','用户已停止本次执行'],['failed','本次执行异常结束']]) {
    const nodes = buildFlowNodes(context, [bad], [], { outcome });
    assert.equal(nodes[1].state, 'failed'); assert.equal(nodes[nodes.length-1].title, '交付回复'); assert.equal(nodes[nodes.length-1].state,outcome);
  }
});

test('时间流仅聚合相邻同类操作，分类流不复制节点或改变原始编号', () => {
  const context = captureProcessFlow(null, input());
  const nodes = buildFlowNodes(context, [step('read','webSearch'),step('cmd'),step('read2','webSearch')], [], { streaming: true });
  assert.equal(groupFlowNodes(nodes,'time').length,4);
  const categories = groupFlowNodes(nodes,'category');
  assert.equal(categories.flatMap(group=>group.nodes).length,nodes.length);
  assert.deepEqual(categories.find(group=>group.title==='检索与网页').nodes.map(node=>node.sequence),[2,4]);
});

test('千步流程保持稳定分组标识，展开状态不依赖索引', () => {
  const context = captureProcessFlow(null, input());
  const steps = Array.from({length:1000},(_,index)=>step(`step-${index}`));
  const groups = groupFlowNodes(buildFlowNodes(context, steps, [], {streaming:true}), 'time');
  assert.equal(groups.length,2); assert.equal(groups[1].id,'group:step-0'); assert.equal(groups[1].nodes.length,1000);
});

test('偏好存储内容损坏时回退普通列表', () => {
  assert.equal(parseProcessView(null),'list'); assert.equal(parseProcessView('invalid'),'list');
  assert.equal(parseProcessView('time'),'time'); assert.equal(parseProcessView('category'),'category');
});

test('MCP 服务标识包含下划线时仍正确识别', () => {
  const node=presentFlowStep(step('cua','mcpToolCall',{tool:'mcp__browser_tools__read_page'}),project);
  assert.equal(node.source,'browser_tools · MCP'); assert.equal(node.subtitle,'read_page');
});

test('搜索外部文件按目标项目展示，不能沿用命令所在项目', () => {
  const context = { projectName: '当前项目', projectPath: 'D:/current', knownProjects: [{ name: '外部项目', path: 'D:/external' }] };
  const node = presentFlowStep(step('search-external', 'commandExecution', { command: 'rg hello D:/external/src/App.ts', cwd: 'D:/current' }), context);
  assert.equal(node.subtitle,'hello'); assert.match(node.hint,/项目：外部项目/);
  assert.equal(node.resource.group.label, '外部项目');
});

test('只根据引擎显式返回的子任务生成分支，不凭调用顺序推断并行', () => {
  const node=presentFlowStep(step('spawn','collabAgentToolCall',{name:'检查界面',agentResults:[{threadId:'a',status:'running'},{threadId:'b',status:'completed'}]}),project);
  assert.equal(node.children.length,2); assert.equal(node.children[0].state,'running'); assert.equal(node.children[1].state,'completed');
  const end=presentFlowStep(node.step,project,'stopped'); assert.equal(end.children[0].state,'unknown');
  assert.equal(presentFlowStep(step('plain'),project).children,undefined);
});

test('不可变步骤的友好摘要缓存，项目及终态变化时重新生成', () => {
  const original=step('cached','commandExecution',{command:'node test.mjs'},'in_progress');
  assert.strictEqual(presentFlowStep(original,project),presentFlowStep(original,project));
  assert.notStrictEqual(presentFlowStep(original,project),presentFlowStep(original,{...project,projectName:'别的项目'}));
  assert.equal(presentFlowStep(original,project,'stopped').state,'stopped');
});

test('同一请求确认实际回合标识后更新关联，保留本页展开状态', () => {
  const initial=captureProcessFlow(null,input({messages:[message('root','user','provisional')]}));
  initial.ui.details['input:root']=true;
  const confirmed=captureProcessFlow(initial,input({messages:[message('root','user','actual')]}));
  assert.equal(confirmed.turnId,'actual'); assert.strictEqual(confirmed.ui,initial.ui);
  assert.equal(getFlowCompletionMessage(confirmed,[message('done','assistant','actual')]).id,'done');
});
