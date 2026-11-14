import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { buildSync, build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { captureProcessFlow } from './process-flow-session.ts';
import { buildFlowNodes, groupFlowNodes, getFlowCategoryGroups, groupFlowCapabilities } from './process-flow-model.ts';

const require = createRequire(import.meta.url);
const result = buildSync({ stdin: { contents: readFileSync(new URL('./ProcessFlow.tsx', import.meta.url),'utf8')+'\nexport { FlowCapabilityGrid, FlowBranch };', resolveDir: fileURLToPath(new URL('.',import.meta.url)), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react/jsx-runtime', 'react-dom'] });
const compiled = { exports: {} };
new Function('require','module','exports',result.outputFiles[0].text)(require,compiled,compiled.exports);
const ProcessFlow = compiled.exports.default;
const panelResult = await build({ stdin: { contents: "export { default, TestStepRow } from './ProcessSteps.tsx'; export { useSessionFollowupStore } from '../../stores/session-followups.ts';", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react/jsx-runtime', 'react-dom'], plugins:[{name:'test-content-row',setup(build){build.onLoad({filter:/[\\/]ProcessSteps\.tsx$/},args=>({contents:readFileSync(args.path,'utf8')+'\nexport { ProcessStepRow as TestStepRow };',loader:'tsx',resolveDir:fileURLToPath(new URL('.',import.meta.url))}));}}] });
const panelCompiled = { exports: {} };
new Function('require','module','exports',panelResult.outputFiles[0].text)(require,panelCompiled,panelCompiled.exports);
const ProcessSteps = panelCompiled.exports.default;
const root = { id: 'root', role: 'user', turn_id: 't', session_id: 's', content: '实现流程视图', created_at: 10 };
const makeContext = (steps = []) => captureProcessFlow(null, { sessionId:'s', messages:[root], followups:[], steps, timeline:[], projectName:'Relay', projectPath:'D:/relay' });
const render = (context, extra = {}) => {
  const { expandOccurrences = true, ...props } = extra;
  if (props.mode === 'category' && expandOccurrences) {
    const nodes=buildFlowNodes(context,context.steps,props.timeline || [],{streaming:true,...props});
    const expand=(group,id=group.id,grouping=context.ui.grouping || 'action')=>{
      const categories=getFlowCategoryGroups(group,grouping);
      if(!categories.length){for(const bucket of groupFlowCapabilities(group.nodes,'action')) context.ui.expanded[`capability:${id}:${bucket.id}`] ??= true;return;}
      const opened=categories.find(category=>context.ui.expanded[`subgroup:${id}:${category.id}`]) || categories.find(category=>category.nodes.some(node=>node.id===context.ui.selectedNodeId || node.children?.some(child=>child.id===context.ui.selectedNodeId))) || categories.find(category=>category.nodes.some(node=>node.step)) || categories[0];
      for(const category of categories){context.ui.expanded[`subgroup:${id}:${category.id}`] ??= category===opened;if(context.ui.expanded[`subgroup:${id}:${category.id}`])expand(category,`${id}:${category.id}`,'action');}
    };
    for(const group of groupFlowNodes(nodes,'category',context.ui.grouping))expand(group);
  }
  return renderToStaticMarkup(React.createElement(ProcessFlow, { context, steps:context.steps, timeline:[], mode:'time', streaming:true, renderDetail: step=>React.createElement('span',null,`detail:${step.id}`), ...props }));
};

test('单次对象一层展开即显示正文，多次才有逐次行，文件摘要不展示绝对路径', () => {
  const context=makeContext([{id:'single-file',type:'fileChange',status:'completed',details:{path:'D:/relay/src/Widget.tsx',kind:'update'}}]);
  context.ui.categoryOpen={action:'category:file'};
  const closed=render(context,{mode:'category',expandOccurrences:false});
  assert.match(closed,/<strong title="Widget.tsx"/); assert.match(closed,/Relay · src/); assert.match(closed,/修改 1次/);
  assert(!closed.includes('D:/relay')); assert(!closed.includes('detail:single-file'));
  const opened=render(context,{mode:'category'});
  assert.match(opened,/detail:single-file/); assert(!opened.includes('flow-node__summary'));
  assert.match(opened,/flow-node--body-only/); assert(!opened.includes('flow-node__time'));
  const many=makeContext(['a','b'].map(id=>({id,type:'commandExecution',status:'completed',details:{command:'cat a.ts'}})));
  many.ui.categoryOpen={action:'category:file'};
  const multiple=render(many,{mode:'category'});
  assert.equal((multiple.match(/class="flow-node__summary"/g)||[]).length,2);
  assert(!multiple.includes('detail:a')); assert(!multiple.includes('detail:b'));
});

test('通道和项目先展开能力类别，类别未展开时不挂载对象与原始记录', () => {
  for(const grouping of ['tool','resource']) {
    const context=makeContext([
      {id:'rule-nested',type:'commandExecution',status:'completed',details:{command:'cat AGENTS.md'}},
      {id:'file-nested',type:'commandExecution',status:'completed',details:{command:'cat src/a.ts'}},
    ]);
    context.ui.grouping=grouping;
    const groups=groupFlowNodes(buildFlowNodes(context,context.steps,[],{streaming:true}),'category',grouping);
    const outer=groups.find(group=>group.nodes.some(node=>node.id==='rule-nested'));
    context.ui.categoryOpen={[grouping]:outer.id};
    const closed=render(context,{mode:'category',expandOccurrences:false});
    assert.match(closed,/flow-category-grid/); assert.match(closed,/title="规则"/); assert.match(closed,/title="文件操作"/);
    assert(!closed.includes('<strong title="AGENTS.md"')); assert(!closed.includes('detail:rule-nested'));
    context.ui.expanded[`subgroup:${outer.id}:category:rule`]=true;
    const rules=render(context,{mode:'category',expandOccurrences:false});
    assert.match(rules,/<strong title="AGENTS.md"/); assert(!rules.includes('<strong title="a.ts"'));
    assert(!rules.includes('detail:rule-nested'));
    const full=render(context,{mode:'category'});
    assert.equal((full.match(/data-flow-node="rule-nested"/g)||[]).length,1);
    assert(!full.includes('data-flow-node="file-nested"'));
    assert.equal((full.match(/flow-branch--full/g)||[]).length,2);
    assert.equal((full.match(/class="flow-branch__connection"/g)||[]).length,2);
  }
});

test('选中记录能自动展开通道内的能力类别和单次正文', () => {
  for(const grouping of ['tool','resource']) {
    const context=makeContext([{id:'selected-nested',type:'commandExecution',status:'in_progress',details:{command:'cat AGENTS.md'}}]);
    context.ui.grouping=grouping; context.ui.selectedNodeId='selected-nested';
    const outer=groupFlowNodes(buildFlowNodes(context,context.steps,[],{streaming:true}),'category',grouping).find(group=>group.nodes.some(node=>node.id==='selected-nested'));
    context.ui.categoryOpen={[grouping]:outer.id};
    const html=render(context,{mode:'category',expandOccurrences:false});
    assert.match(html,/detail:selected-nested/); assert.equal((html.match(/data-flow-node="selected-nested"/g)||[]).length,1);
  }
});

test('助手通道不再嵌套助手类别，摘要省略且展开保留完整进度原文', () => {
  const context=makeContext(); context.ui.grouping='tool'; context.ui.categoryOpen={tool:'tool:助手消息'};
  const content='核查每个事件的原始字段、身份和分类。'.repeat(20);
  const timeline=[{type:'narrative',itemId:'long-progress',content}];
  const closed=render(context,{mode:'category',timeline,expandOccurrences:false});
  assert(!closed.includes('flow-category-grid')); assert.equal((closed.match(/title="助手消息"/g)||[]).length,1);
  assert.match(closed,/<strong title="进度说明"/); assert(!closed.includes(content));
  const opened=render(context,{mode:'category',timeline}); assert(opened.includes(content));
  const css=readFileSync(new URL('../../styles/process-flow.css',import.meta.url),'utf8');
  assert.match(css,/\.flow-capability__identity small\s*\{[^}]*overflow:\s*hidden[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/);
});

test('能力对象跨三视角沿用相同色调标识和图标，通道项目不按事件组成变色', () => {
  for(const grouping of ['action','tool','resource']) {
    const context=makeContext([{id:'appearance-read',type:'commandExecution',status:'completed',details:{command:'cat src/a.ts'}},{id:'appearance-build',type:'commandExecution',status:'in_progress',details:{command:'npm run build'}}]);
    context.ui.grouping=grouping;
    const outer=groupFlowNodes(buildFlowNodes(context,context.steps,[],{streaming:true}),'category',grouping).find(group=>group.nodes.some(node=>node.id==='appearance-read'));
    context.ui.categoryOpen={[grouping]:outer.id};
    context.ui.expanded[`subgroup:${outer.id}:category:file`]=true;
    const html=render(context,{mode:'category'});
    assert.match(html,/<section class="flow-capability" data-flow-style="file">[\s\S]*?data-process-icon="file"/);
    assert.match(html,new RegExp(`data-flow-group="${outer.id}" data-flow-style="${grouping==='tool'?'终端':grouping==='resource'?'project':'file'}"`));
    assert.match(html,/data-flow-node="appearance-read"[^>]*data-flow-style="file"/);
  }
});

test('时间流与分类流的文件事件色调一致，读取修改删除的动作图标对应一致', () => {
  const context=makeContext([{id:'tone-read',type:'commandExecution',status:'completed',details:{command:'cat a.ts'}},{id:'tone-edit',type:'fileChange',status:'completed',details:{path:'a.ts',kind:'update'}},{id:'tone-delete',type:'fileChange',status:'completed',details:{path:'a.ts',kind:'delete'}}]);
  context.ui.categoryOpen={action:'category:file'};
  for(const mode of ['time','category']) {
    const html=render(context,{mode});
    for(const [id,icon] of [['tone-read','file'],['tone-edit','edit'],['tone-delete','remove']]) {
      const card=html.match(new RegExp(`<article[^>]*data-flow-node="${id}"[\\s\\S]*?<\/article>`))[0];
      assert.match(card,/data-flow-style="file"/); assert.match(card,new RegExp(`data-process-icon="${icon}"`)); assert.match(card,/flow-node__icon" title="文件操作"/);
    }
  }
});

test('MCP服务名包含动作词和冒号时仍使用固定工具色调与图标', () => {
  const context=makeContext([{id:'named-mcp',type:'mcpToolCall',status:'completed',details:{server:'删除:服务',tool:'custom.run'}}]);
  context.ui.grouping='tool'; context.ui.categoryOpen={tool:'tool:删除:服务 · MCP'};
  const html=render(context,{mode:'category',expandOccurrences:false});
  const heading=html.match(/<section[^>]*data-flow-group="tool:删除:服务 · MCP"[\s\S]*?<\/button>/)[0];
  assert.match(heading,/data-flow-style="mcp"/); assert.match(heading,/data-process-icon="tool"/); assert(!heading.includes('data-process-icon="remove"'));
});

test('技能在三种分类视角均先按所属技能汇总，再按具体能力及次数显示', () => {
  for(const grouping of ['action','tool','resource']) {
    const context=makeContext([
      {id:'skill-doc',type:'commandExecution',status:'completed',details:{command:'cat ai/skills/Db/SKILL.md'}},
      ...['first','second'].map(id=>({id,type:'commandExecution',status:'completed',details:{command:'python ai/skills/Db/scripts/db.py query'}})),
      {id:'skill-write',type:'commandExecution',status:'in_progress',details:{command:'python ai/skills/Db/scripts/db.py write'}},
    ]);
    context.ui.grouping=grouping;context.ui.selectedNodeId='first';
    const group=groupFlowNodes(buildFlowNodes(context,context.steps,[],{streaming:true}),'category',grouping).find(group=>group.nodes.some(node=>node.id==='first'));
    context.ui.categoryOpen={[grouping]:group.id};
    const html=render(context,{mode:'category'});
    assert.match(html,/title="Db · Relay · ai\/skills"/);assert.match(html,/query · db.py/);assert.match(html,/write · db.py/);assert.match(html,/读取 · SKILL.md/);assert.match(html,/2 次执行/);
    assert(!html.includes('脚本与代码'));assert(!html.includes('flow-node__time'));
    for(const id of ['skill-doc','first','second','skill-write'])assert.equal((html.match(new RegExp(`data-flow-node="${id}"`,'g'))||[]).length,1);
  }
});

test('技能汇总默认折叠，展开所属技能只显示能力摘要，单次能力再展开直达正文', () => {
  const context=makeContext([{id:'single-skill-script',type:'commandExecution',status:'completed',details:{command:'python ai/skills/Db/scripts/db.py query'}}]);
  context.ui.categoryOpen={action:'category:skill'};
  const nodes=buildFlowNodes(context,context.steps,[],{streaming:true});const group=groupFlowNodes(nodes,'category').find(group=>group.id==='category:skill');const owner=getFlowCategoryGroups(group,'action')[0];
  const closed=render(context,{mode:'category',expandOccurrences:false});assert.match(closed,/Db · Relay · ai\/skills/);assert(!closed.includes('query · db.py'));
  context.ui.expanded[`subgroup:${group.id}:${owner.id}`]=true;
  const abilities=render(context,{mode:'category',expandOccurrences:false});assert.match(abilities,/query · db.py/);assert(!abilities.includes('detail:single-skill-script'));
  const opened=render(context,{mode:'category'});assert.match(opened,/detail:single-skill-script/);assert(!opened.includes('flow-node__summary'));
});

test('大量技能对象仍按四十项分段，选中较后技能能穿透所属技能层定位正文', () => {
  const context=makeContext(Array.from({length:80},(_,index)=>({id:`skill-owner-${index}`,type:'commandExecution',status:'completed',details:{command:`python ai/skills/Tool${index}/scripts/run.py query`}})));
  context.ui.categoryOpen={action:'category:skill'};context.ui.selectedNodeId='skill-owner-70';
  const html=render(context,{mode:'category',expandOccurrences:false});
  assert.equal((html.match(/class="flow-branch__name" title="Tool/g)||[]).length,40);assert.match(html,/detail:skill-owner-70/);assert(!html.includes('title="Tool0 ·'));
  assert.match(html,/展开此前汇总项/);assert.match(html,/展开后续汇总项/);
});

test('手动展开较后技能后没有选中记录，仍保留其所在分页和能力摘要', () => {
  const context=makeContext(Array.from({length:80},(_,index)=>({id:`manual-owner-${index}`,type:'commandExecution',status:'completed',details:{command:`python ai/skills/Tool${index}/scripts/run.py query`}})));
  context.ui.categoryOpen={action:'category:skill'};
  const group=groupFlowNodes(buildFlowNodes(context,context.steps,[],{streaming:true}),'category').find(group=>group.id==='category:skill');
  const owner=getFlowCategoryGroups(group,'action').find(owner=>owner.nodes.some(node=>node.id==='manual-owner-68'));
  context.ui.expanded[`subgroup:${group.id}:${owner.id}`]=true;
  const html=render(context,{mode:'category',expandOccurrences:false});
  assert.match(html,/title="Tool68 · Relay/);assert.match(html,/query · run.py/);assert(!html.includes('title="Tool0 ·'));
  assert(!html.includes('detail:manual-owner-68'));assert.equal((html.match(/class="flow-branch__name" title="Tool/g)||[]).length,40);
});

test('普通步骤保留原头部，分类详情只显示正文和完整文件清单，无假折叠或耗时', () => {
  const Row=panelCompiled.exports.TestStepRow;
  const step={id:'content-only',type:'commandExecution',status:'completed',details:{command:'Get-Date',aggregatedOutput:'test output',durationMs:1250}};
  const renderRow=extra=>renderToStaticMarkup(React.createElement(Row,{step,full:true,...extra}));
  assert.match(renderRow({}),/process-step__main/);
  const body=renderRow({contentOnly:true,hideTiming:true});
  assert(!body.includes('process-step__main')); assert(!body.includes('aria-expanded')); assert.match(body,/Get-Date/); assert.match(body,/test output/);
  const files=renderToStaticMarkup(React.createElement(Row,{step:{id:'files',type:'fileChange',status:'completed',details:{changes:[{path:'src/A.ts',kind:'add'},{path:'src/B.ts',kind:'delete'}],diff:'file diff'}},full:true,contentOnly:true,hideTiming:true}));
  assert.match(files,/flow-file-list/); assert.match(files,/src\/A.ts/); assert.match(files,/src\/B.ts/); assert.match(files,/file diff/); assert(!files.includes('process-step__main'));
});

test('多段助手进度只显示一个消息汇总对象，每条原文仍可分别查看', () => {
  const context=makeContext(); context.ui.categoryOpen={action:'category:assistant'};
  const html=render(context,{mode:'category',timeline:[{type:'narrative',itemId:'n1',content:'先核对字段'},{type:'narrative',itemId:'n2',content:'已找到遗漏'}]});
  assert.equal((html.match(/class="flow-capability__heading"/g)||[]).length,1); assert.match(html,/2 条消息/); assert.match(html,/最新：已找到遗漏/);
  assert.match(html,/data-flow-node="n1"/); assert.match(html,/data-flow-node="n2"/); assert.match(html,/先核对字段/);
});

test('单次父操作已完成时仍提示子任务失败，不能仅显示完成状态', () => {
  const context=makeContext([{id:'parent-state',type:'collabAgentToolCall',status:'completed',details:{agentResults:[{threadId:'child',status:'errored'}]}}]);
  context.ui.categoryOpen={action:'category:collaboration'};
  const html=render(context,{mode:'category',expandOccurrences:false});
  const heading=html.match(/class="flow-capability__heading"[\s\S]*?<\/button>/)[0];
  assert.match(heading,/子任务/); assert.match(heading,/失败/);
});

test('重复技能归并为一张默认收起的对象卡，展开保留每次状态和详情', () => {
  const context=makeContext([
    {id:'skill-read1',type:'commandExecution',status:'completed',details:{command:'cat ai/skills/pdf/SKILL.md'}},
    {id:'skill-read2',type:'commandExecution',status:'incomplete',details:{command:'Get-Content ai/skills/pdf/SKILL.md -TotalCount 10'}},
  ]);
  context.ui.categoryOpen={action:'category:skill'};
  const closed=render(context,{mode:'category',expandOccurrences:false});
  assert.equal((closed.match(/class="flow-capability"/g)||[]).length,0);
  assert.match(closed,/title="pdf · Relay · ai\/skills"/); assert.match(closed,/2 条记录/); assert.match(closed,/1 项失败/);
  assert(!closed.includes('data-flow-node='));
  const opened=render(context,{mode:'category'});
  assert.match(opened,/2 次读取/); assert.equal((opened.match(/class="flow-capability__heading"/g)||[]).length,1);
  assert.match(opened,/data-flow-node="skill-read1"/); assert.match(opened,/flow-node--failed[^>]*data-flow-node="skill-read2"/);
  assert.match(opened,/前 10 行/);
});

test('MCP在服务下按能力汇总调用次数，切换通道和项目不复制事件', () => {
  const context=makeContext(['a','b'].map((path,index)=>({id:`mcp-use-${index}`,type:'mcpToolCall',status:'completed',details:{server:'Figma',tool:'get_design_context',arguments:{path}}})));
  for(const grouping of ['action','tool','resource']){
    context.ui.grouping=grouping;
    const groups=groupFlowNodes(buildFlowNodes(context,context.steps,[],{streaming:true}),'category',grouping);
    context.ui.categoryOpen={[grouping]:groups.find(group=>group.nodes.some(node=>node.id==='mcp-use-0')).id};
    const html=render(context,{mode:'category'});
    assert.match(html,/Figma · MCP/); assert.match(html,/get_design_context/); assert.match(html,/2 次调用/);
    for(const id of ['mcp-use-0','mcp-use-1']) assert.equal((html.match(new RegExp(`data-flow-node="${id}"`,'g'))||[]).length,1);
  }
});

test('大量不同对象按汇总项分段，大量重复调用只挂载二十次记录', () => {
  const distinct=makeContext(Array.from({length:200},(_,i)=>({id:`entry-${i}`,type:'commandExecution',status:'completed',details:{command:`node scripts/${i}.mjs`}})));
  distinct.ui.categoryOpen={action:'category:script'};
  const html=render(distinct,{mode:'category',expandOccurrences:false});
  assert.equal((html.match(/class="flow-capability"/g)||[]).length,40); assert.match(html,/展开后续汇总项/);
  const repeated=makeContext(Array.from({length:1000},(_,i)=>({id:`repeat-${i}`,type:'commandExecution',status:'completed',details:{command:'node same.mjs'}})));
  repeated.ui.categoryOpen={action:'category:script'};
  const calls=render(repeated,{mode:'category'});
  assert.equal((calls.match(/class="flow-capability__heading"/g)||[]).length,1); assert.match(calls,/1000 次执行/);
  assert.equal((calls.match(/data-flow-node=/g)||[]).length,20); assert.match(calls,/展开此前 20 次记录/);
});

test('展开重复调用时优先展示较早的待处理记录，不被末尾完成记录挤掉', () => {
  const context=makeContext(Array.from({length:100},(_,i)=>({id:`active-repeat-${i}`,type:'commandExecution',status:i===0?'in_progress':'completed',details:{command:'node same.mjs'}})));
  context.ui.categoryOpen={action:'category:script'};
  const html=render(context,{mode:'category'});
  assert.match(html,/data-flow-node="active-repeat-0"/);
  assert.equal((html.match(/data-flow-node=/g)||[]).length,20);
  assert.match(html,/展开后续记录/);
  const later=makeContext(Array.from({length:100},(_,i)=>({id:`later-${i}`,type:'commandExecution',status:i===99?'in_progress':'completed',details:{command:`node scripts/${i}.mjs`}})));
  later.ui.categoryOpen={action:'category:script'};
  const buckets=render(later,{mode:'category',expandOccurrences:false});
  assert.match(buckets,/<strong title="99.mjs"/); assert.match(buckets,/Relay · scripts/);
  assert(!buckets.includes('<strong title="0.mjs"'));
  assert.equal((buckets.match(/class="flow-capability"/g)||[]).length,40);
});

test('分类流只保留类别切换，旧筛选状态不隐藏记录或子任务', () => {
  const context=makeContext([
    {id:'read',type:'commandExecution',status:'completed',details:{command:'cat a.ts'}},
    {id:'failed',type:'commandExecution',status:'incomplete',details:{command:'node job.mjs'}},
    {id:'agents',type:'collabAgentToolCall',status:'completed',details:{tool:'wait',agentResults:[{threadId:'done',status:'completed'},{threadId:'error',status:'errored'}]}},
  ]);
  context.ui.filters={provider:'终端',state:'failed'}; context.ui.filtersOpen=true;
  context.ui.categoryOpen={action:'category:script'};
  const html=render(context,{mode:'category'});
  assert.match(html,/aria-label="查看方式"/);
  assert.equal((html.match(/<select\b/g)||[]).length,1);
  assert(!html.includes('筛选')); assert(!html.includes('清除筛选'));
  assert.match(html,/data-flow-node="failed"/); assert(!html.includes('data-flow-node="read"'));
  context.ui.categoryOpen={action:'category:file'};
  assert.match(render(context,{mode:'category'}),/data-flow-node="read"/);
  context.ui.categoryOpen={action:'category:collaboration'}; context.ui.expanded['children:agents']=true;
  const children=render(context,{mode:'category'});
  assert.match(children,/data-flow-node="agents:agent:done"/); assert.match(children,/data-flow-node="agents:agent:error"/);
  const time=render(context);
  assert.match(time,/data-flow-node="read"/); assert.match(time,/data-flow-node="failed"/);
  assert(!time.includes('筛选执行状态'));
});

test('六个摘要位置实际渲染分离动作、身份、条件、状态与提供方', () => {
  const context=makeContext([
    {id:'mcp-layout',type:'mcpToolCall',status:'completed',details:{server:'xinshu',tool:'meta_data.search',arguments:{db_name:'analytics',keyword:'orders',limit:20},durationMs:1250}},
    {id:'auth-layout',type:'interaction',status:'completed',details:{interactionKind:'command_approval',command:'node scripts/check.mjs',decisionSource:'project_trust',resolvedAction:'accept'}},
  ]);
  const html=render(context);
  assert.match(html,/flow-node__title" title="搜索元数据"/);
  assert.match(html,/flow-node__subtitle" title="meta_data.search"/);
  assert.match(html,/flow-node__hint" title="数据库：analytics · 关键词：orders · 上限 20"/);
  assert.match(html,/flow-node__source" title="xinshu · MCP"/);
  assert.match(html,/flow-node__duration[^>]*>1\.25 秒/);
  assert.match(html,/flow-node__title" title="请求授权"/);
  assert.match(html,/flow-node__subtitle" title="node scripts\/check.mjs"/);
  assert.match(html,/flow-node__hint" title="决策：项目规则"/);
  assert.match(html,/已允许/); assert.match(html,/flow-node__source" title="引擎"/);
  assert(!html.includes('flow-node__source" title="信任规则"'));
});

test('结束说明不挤占身份行，已回答标记不把失败卡片改成成功', () => {
  const context=makeContext([
    {id:'unfinished-layout',type:'commandExecution',status:'in_progress',details:{command:'node scripts/check.mjs'}},
    {id:'failed-answer',type:'interaction',status:'incomplete',details:{interactionKind:'async_question',questions:[{title:'确认结果'}]}},
  ]);
  const html=render(context,{streaming:false,outcome:'completed',answeredIds:new Set(['failed-answer'])});
  assert.match(html,/flow-node__subtitle" title="scripts\/check.mjs"/);
  assert.match(html,/flow-node__hint" title="node · 本次执行已结束，此步骤结果未确认"/);
  const failed=html.match(/<article[^>]*data-flow-node="failed-answer"[\s\S]*?<\/article>/)[0];
  assert.match(failed,/flow-node--failed/); assert.match(failed,/失败/); assert(!failed.includes('已回答'));
});

test('网页打开和查找、文件删除在流程及普通列表保留实际动作', () => {
  const steps=[{id:'open-page',type:'webSearch',status:'completed',details:{action:{type:'openPage',url:'https://example.test/doc'}}},
    {id:'find-page',type:'webSearch',status:'completed',details:{action:{type:'findInPage',url:'https://example.test/doc',pattern:'needle'}}},
    {id:'delete-file',type:'fileChange',status:'completed',details:{changes:[{path:'a.ts',kind:{type:'delete'}}]}}];
  const flow=render(makeContext(steps));
  const list=renderToStaticMarkup(React.createElement(ProcessSteps,{steps,settled:true,defaultCollapsed:false,full:true}));
  for(const html of [flow,list]) {
    assert.match(html,/打开网页/); assert.match(html,/页内查找/); assert.match(html,/删除文件/); assert.match(html,/https:\/\/example\.test\/doc/);
  }
  assert.match(flow,/flow-node__subtitle" title="needle"/);
  assert.match(flow,/flow-node__hint" title="网页：https:\/\/example.test\/doc"/);
  assert.match(flow,/data-process-icon="web"/);
});

test('命令身份实际渲染保留脚本和语法检查名称，普通命令不重复第三行', () => {
  const plain=render(makeContext([{id:'plain',type:'commandExecution',status:'completed',details:{command:'Get-ChildItem src --token private-value'}}]));
  assert.match(plain,/title="执行命令"/); assert.match(plain,/flow-node__subtitle" title="Get-ChildItem"/);
  assert(!plain.includes('flow-node__hint')); assert(!plain.includes('private-value'));
  const script=render(makeContext([{id:'script',type:'commandExecution',status:'completed',details:{command:'node -c scripts/check.js'}}]));
  assert.match(script,/title="检查脚本语法"/); assert.match(script,/flow-node__subtitle" title="scripts\/check.js"/);
  assert.match(script,/flow-node__hint" title="node"/);
});

test('折叠摘要真正显示结构化第三行，MCP关键词不在两行间重复', () => {
  const context=makeContext([{id:'plan-progress',type:'plan',status:'completed',details:{plan:[{status:'completed'},{status:'in_progress'}]}},{id:'tool-target',type:'mcpToolCall',status:'completed',details:{server:'remote',tool:'meta_data.search',arguments:{db_name:'analytics',keyword:'orders',limit:8}}}]);
  const html=render(context);
  assert.match(html,/flow-node__hint" title="已完成 1\/2 项 · 1 项进行中"/);
  assert.match(html,/flow-node__subtitle" title="meta_data.search"/);
  assert.match(html,/flow-node__hint" title="数据库：analytics · 关键词：orders · 上限 8"/);
  const toolCard=html.slice(html.indexOf('data-flow-node="tool-target"'));
  assert(!toolCard.includes('meta_data.search · orders'));
});

test('历史用户输入在独立记录中保留实际时间与定位提示，摘要保留范围与真实耗时', () => {
  const context=makeContext();
  context.inputs=[{id:'timed-extra',recordedAt:150,label:'用户补充要求',content:'补充',delivery:'已保存',state:'completed',positionKnown:false}];
  context.ui.categoryOpen={action:'category:input'};
  const html=render(context,{mode:'category'});
  assert.match(html,/按消息记录时间排列/); assert(!html.includes('flow-node__turn'));
  const read=makeContext([{id:'ranged',type:'commandExecution',status:'completed',details:{command:'Get-Content app.ts -TotalCount 180',firstObservedAt:1000,startedObservedAt:1000,completedObservedAt:2500}}]);
  const card=render(read);
  assert.match(card,/flow-node__hint" title="前 180 行"/);
  assert.match(card,/flow-node__duration[^>]*>1\.50 秒/);
});

test('没有已报告运行事件时保持独立处理提示，不把最近完成事件改为运行或猜测思考', () => {
  const context=makeContext([{id:'done',type:'commandExecution',status:'completed',details:{command:'node done.mjs'}}]);
  const html=render(context,{runtimeStatus:{state:'processing',label:'处理中'}});
  assert.match(html,/处理中 · 等待新事件/); assert.match(html,/最近记录：/);
  assert.match(html,/助手仍在处理，等待新的可展示事件/);
  assert.match(html,/flow-node--completed[^>]*data-flow-node="done"/);
  assert(!html.includes('flow-node--running'));
  assert(!html.includes('正在分析（引擎已报告）'));
  assert(!render(context,{streaming:false}).includes('process-flow__continuation'));
});

test('仅明确的分析事件显示分析状态，并为运行空档和导航保留固定位置', () => {
  const context=makeContext([{id:'analysis',type:'reasoning',status:'in_progress',details:{text:'执行思路摘要'}}]);
  const html=render(context);
  assert.match(html,/正在分析（引擎已报告）/);
  assert.match(html,/process-flow__quiet" aria-hidden="true"/);
  assert.match(html,/process-flow__activity-action/);
});

test('普通列表与流程说明事件共享进行中、停止中和完成状态', () => {
  const timeline=[{type:'narrative',itemId:'earlier-note',content:'较早说明'},{type:'narrative',itemId:'current-note',content:'正在追加的说明'}];
  const context=makeContext();
  for (const [settled,narrativeStatus,tone,state] of [[false,'in_progress','in_progress','running'],[false,'stopped','stopped','stopped'],[true,'completed','completed','completed']]) {
    const list=renderToStaticMarkup(React.createElement(ProcessSteps,{steps:[],processContent:'较早说明\n正在追加的说明',processTimeline:timeline,settled,narrativeStatus,defaultCollapsed:false,full:true}));
    assert.match(list,new RegExp(`process-narrative--${tone}`));
    const flow=render(context,{timeline,streaming:!settled,narrativeStatus});
    assert.match(flow,new RegExp(`flow-node--${state}[^>]*data-flow-node="current-note"`));
    assert.match(flow,/flow-node--completed[^>]*data-flow-node="earlier-note"/);
  }
});

test('分类汇总保留运行与完成状态，不把先前记录改成运行', () => {
  const context=makeContext([{id:'before',type:'commandExecution',status:'completed',details:{command:'node before.mjs'}},{id:'active',type:'commandExecution',status:'in_progress',details:{command:'node active.mjs'}}]);
  context.ui.categoryOpen={action:'category:script'};
  const html=render(context,{mode:'category'});
  assert.match(html,/1 项待完成/);
  assert.match(html,/flow-node--completed[^>]*data-flow-node="before"/);
  assert.match(html,/flow-node--running[^>]*data-flow-node="active"/);
});

test('时间流只有一个整段运行光点，等待回答、恢复和已完成不伪装成运行', () => {
  const context=makeContext([{id:'before',type:'commandExecution',status:'completed',details:{command:'node before.mjs'}},{id:'active',type:'webSearch',status:'in_progress',details:{query:'文档'}}]);
  assert.equal((render(context).match(/class="flow-travel-marker"/g)||[]).length,1);
  const waiting=makeContext([{id:'ask',type:'interaction',status:'in_progress',details:{interactionKind:'async_question'}}]);
  assert(!render(waiting).includes('flow-travel-marker'));
  assert(!render(context,{streaming:false,outcome:'completed'}).includes('flow-travel-marker'));
  assert(!render(context,{runtimeStatus:{state:'recovering',label:'恢复中'}}).includes('flow-travel-marker'));
  assert(!render(context,{mode:'category'}).includes('flow-travel-marker'));
});

test('历史原始输入缺失显示上下文提示，不当作结果未知的操作或编号步骤', () => {
  const context=makeContext();
  context.root={id:'missing:history',content:'',label:'原始输入未加载',delivery:'历史窗口未包含原始输入',state:'unknown',positionKnown:false};
  const nodes=buildFlowNodes(context,[],[],{streaming:false});
  assert.equal(nodes[0].sequence,0); assert.equal(nodes[1].sequence,1);
  const html=render(context,{streaming:false});
  assert.match(html,/历史上下文提示/); assert.match(html,/历史窗口未包含原始输入/);
  assert(!html.includes('结果未确认'));
  context.ui.categoryOpen={action:'category:input'};
  const category=render(context,{mode:'category',streaming:false});
  assert.match(category,/历史上下文提示/); assert.match(category,/原始用户输入未加载/); assert.match(category,/未加载/);
  assert(!category.includes('结果未确认'));
});

test('展开分类组保留整组边框和标题关联，汇总之间不画顺序连线', () => {
  const context=makeContext([{id:'one',type:'commandExecution',status:'completed',details:{command:'node task.mjs'}},{id:'two',type:'commandExecution',status:'completed',details:{command:'node next.mjs'}}]);
  context.ui.categoryOpen={action:'category:script'};
  const html=render(context,{mode:'category'});
  assert.match(html,/flow-branch--full/);
  assert.match(html,/flow-branch__connection/);
  assert(!html.includes('flow-capability--full'));
  assert(!html.includes('--flow-group-left')); assert(!html.includes('--flow-group-width'));
  assert.match(html,/flow-capability-grid/); assert(!html.includes('flow-node__turn'));
});

test('处理状态整行保留最近已报告事件信息，操作节点不隐藏引擎来源', () => {
  const context=makeContext([{id:'plan-source',type:'plan',status:'completed',details:{plan:[]}}]);
  const html=render(context);
  assert.match(html,/process-flow__activity-detail[^>]*title="最近记录：更新执行计划/);
  assert.match(html,/flow-node__source[^>]*title="引擎"/);
});

test('旧运行字段已有成功或失败回执时，普通详情与流程卡片使用同一终态', () => {
  for (const exitCode of [0,1]) {
    const steps=[{id:'receipt',type:'commandExecution',status:'in_progress',details:{command:'node task.mjs',exitCode,completedObservedAt:2000}}];
    const context=makeContext(steps);
    assert.match(render(context),new RegExp(`flow-node--${exitCode?'failed':'completed'}`));
    const html=renderToStaticMarkup(React.createElement(ProcessSteps,{steps,settled:false,defaultCollapsed:false,full:true}));
    assert.match(html,new RegExp(`process-step-status--${exitCode?'failed':'success'}`));
    assert(!html.includes('process-step-status--running'));
  }
});

test('分类节点使用独立卡片容器，展开详情不会出现在相邻节点内', () => {
  const context=makeContext([{id:'first',type:'commandExecution',status:'completed',details:{command:'node first.mjs'}},{id:'second',type:'commandExecution',status:'completed',details:{command:'node second.mjs'}}]);
  context.ui.categoryOpen={action:'category:script'}; context.ui.details.first=true;
  const html=render(context,{mode:'category'});
  assert.equal((html.match(/class="flow-capability"/g)||[]).length,2);
  const first=html.match(/<article[^>]*data-flow-node="first"[\s\S]*?<\/article>/)[0];
  const second=html.match(/<article[^>]*data-flow-node="second"[\s\S]*?<\/article>/)[0];
  assert.match(first,/detail:first/); assert(!first.includes('detail:second'));
  assert.match(second,/detail:second/); assert(!second.includes('detail:first'));
  assert(!first.includes('flow-node__summary')); assert(!second.includes('flow-node__summary'));
  assert.equal((html.match(/class="flow-capability__occurrences[ "]/g)||[]).length,2);
});

test('双列卡片详情只在自己的卡片内展开，旁边卡片保持折叠', () => {
  const context=makeContext([{id:'first',type:'commandExecution',status:'completed',details:{command:'node first.mjs'}},{id:'second',type:'commandExecution',status:'completed',details:{command:'node second.mjs'}}]);
  const buckets=groupFlowCapabilities(buildFlowNodes(context,context.steps,[],{streaming:true}).filter(node=>node.step),'action');
  context.ui.expanded[`capability:test:${buckets[0].id}`]=true;
  const html=renderToStaticMarkup(React.createElement(compiled.exports.FlowCapabilityGrid,{buckets,groupId:'test',columns:2,context,renderDetail:step=>`detail:${step.id}`}));
  assert.equal((html.match(/flow-capability__heading/g)||[]).length,2);
  assert(!html.includes('flow-capability--full'));
  const cards=html.split('<section class="flow-capability"').slice(1);
  assert.equal(cards.length,2);assert.match(cards[0],/aria-expanded="true"/);assert.match(cards[0],/detail:first/);
  assert.match(cards[1],/aria-expanded="false"/);assert(!cards[1].includes('flow-capability__occurrences'));
  assert(html.indexOf(`title="${buckets[1].label}"`)>html.indexOf('detail:first'));
  assert.equal((html.match(/detail:first/g)||[]).length,1);assert(!html.includes('detail:second'));
});

test('组整行面板按标题所在列连接边框，首尾连接保留整体外轮廓', () => {
  const context=makeContext([{id:'script',type:'commandExecution',status:'completed',details:{command:'node run.mjs'}}]);
  const group=groupFlowNodes(buildFlowNodes(context,context.steps,[],{streaming:true}),'category').find(group=>group.id==='category:script');
  for(const [columns,anchorColumn,anchor] of [[1,1,'both'],[2,1,'start'],[2,2,'end']]){
    const html=renderToStaticMarkup(React.createElement(compiled.exports.FlowBranch,{group,context,renderDetail:()=>null,section:'body',open:true,columns,anchorColumn}));
    assert.match(html,/flow-branch--full/);assert(html.includes(`data-flow-anchor="${anchor}"`));
    assert(html.includes(`grid-template-columns:repeat(${columns}, minmax(0, 1fr))`));assert(html.includes(`grid-column:${anchorColumn}`));
  }
});

test('多记录汇总组在下一整行显示记录，记录自己的详情仍独立展开', () => {
  const context=makeContext([
    {id:'first',type:'commandExecution',status:'completed',details:{command:'node same.mjs'}},
    {id:'second',type:'commandExecution',status:'completed',details:{command:'node same.mjs'}},
    {id:'other',type:'commandExecution',status:'completed',details:{command:'node other.mjs'}},
  ]);
  const buckets=groupFlowCapabilities(buildFlowNodes(context,context.steps,[],{streaming:true}).filter(node=>node.step),'action');
  context.ui.expanded[`capability:test:${buckets[0].id}`]=true;context.ui.details.first=true;
  const html=renderToStaticMarkup(React.createElement(compiled.exports.FlowCapabilityGrid,{buckets,groupId:'test',columns:2,context,renderDetail:step=>`detail:${step.id}`}));
  assert.match(html,/flow-capability--group-body/);assert.match(html,/flow-branch--full/);
  assert(html.indexOf('title="other.mjs"')<html.indexOf('data-flow-node="first"'));
  const first=html.match(/<article[^>]*data-flow-node="first"[\s\S]*?<\/article>/)[0],second=html.match(/<article[^>]*data-flow-node="second"[\s\S]*?<\/article>/)[0];
  assert.match(first,/detail:first/);assert.match(second,/aria-expanded="false"/);assert(!second.includes('detail:second'));
  assert.equal((html.match(/data-flow-node="first"/g)||[]).length,1);assert(!html.includes('data-flow-node="other"'));
});

test('同排多记录汇总只挂载一个连接面板，旧的多个展开标记不会串接边框', () => {
  const context=makeContext(['a','a','b','b'].map((name,index)=>({id:`row-${index}`,type:'commandExecution',status:'completed',details:{command:`node ${name}.mjs`}})));
  const buckets=groupFlowCapabilities(buildFlowNodes(context,context.steps,[],{streaming:true}).filter(node=>node.step),'action');
  for(const bucket of buckets)context.ui.expanded[`capability:test:${bucket.id}`]=true;
  const html=renderToStaticMarkup(React.createElement(compiled.exports.FlowCapabilityGrid,{buckets,groupId:'test',columns:2,context,renderDetail:()=>null}));
  assert.equal((html.match(/flow-capability--group-body/g)||[]).length,1);
  const headings=[...html.matchAll(/class="flow-capability__heading" aria-expanded="(true|false)"/g)].map(match=>match[1]);
  assert.deepEqual(headings,['true','false']);assert(html.includes('data-flow-node="row-0"'));assert(!html.includes('data-flow-node="row-2"'));
});

test('同一对象记录从单次变多次再变单次，持久展开偏好保持一致', () => {
  const context=makeContext([0,1].map(index=>({id:`resize-${index}`,type:'commandExecution',status:'completed',details:{command:'node same.mjs'}})));
  const bucket=groupFlowCapabilities(buildFlowNodes(context,context.steps,[],{streaming:true}).filter(node=>node.step),'action')[0];
  context.ui.expanded[`capability:test:${bucket.id}`]=true;
  for(const size of [1,2,1]){
    const html=renderToStaticMarkup(React.createElement(compiled.exports.FlowCapabilityGrid,{buckets:[{...bucket,nodes:bucket.nodes.slice(0,size)}],groupId:'test',columns:2,context,renderDetail:step=>`detail:${step.id}`}));
    assert.match(html,/class="flow-capability__heading" aria-expanded="true"/);
    assert.equal(html.includes('flow-capability--group-body'),size>1);
    if(size===1)assert.match(html,/detail:resize-0/);
  }
});

test('完成消息提供三种Tab，消息偏好独立，未载入详情不画不完整流程', () => {
  const current=makeContext(); current.ui.panelExpanded=true; current.ui.view='time';
  const html=renderToStaticMarkup(React.createElement(ProcessSteps,{steps:[],flowContext:current,settled:true,flowDetailsPending:true}));
  assert.match(html,/aria-pressed="true">时间流/); assert.match(html,/处理详情尚未加载/);
  assert(!html.includes('data-flow-node='));
  const other=makeContext(); other.ui.panelExpanded=true;
  const defaultHtml=renderToStaticMarkup(React.createElement(ProcessSteps,{steps:[],flowContext:other,settled:true}));
  assert.match(defaultHtml,/aria-pressed="true">普通列表/); assert.match(defaultHtml,/>分类流/);
});

test('运行节点无出线仍有状态动效，折叠分类组独立显示运行指示', () => {
  const context=makeContext([{id:'last',type:'commandExecution',status:'in_progress',details:{command:'node app.mjs'}}]);
  const time=render(context);
  assert.match(time,/flow-node--running/); assert.match(time,/execution-status-spinner/);
  const category=render(context,{mode:'category'});
  assert(!category.includes('data-flow-node='));
  assert.match(category,/flow-branch__state[^>]*><span[^>]*execution-status-spinner/);
  assert(!render(context,{streaming:false}).includes('execution-status-spinner'));
});

test('分类连线不指向发生位置未记录的补充卡片', () => {
  const context=makeContext();
  context.inputs=[{id:'unknown',label:'用户补充要求',content:'补充',delivery:'已保存',state:'completed',positionKnown:false}];
  context.ui.categoryOpen={action:'category:input'};
  const html=render(context,{mode:'category'});
  assert.match(html,/具体发生位置未记录/);
  assert(!html.includes('flow-node__connector'));
  assert(!html.includes('flow-node__turn'));
});

test('输入附件在摘要中直接显示文件名和类型图标，无需展开详情', () => {
  const context=makeContext();
  context.root.attachments=[{id:'image',kind:'uploaded_file',name:'参考.png',mimeType:'image/png',size:100,available:true},{id:'pdf',kind:'host_file',name:'需求.pdf',size:200}];
  const html=render(context);
  assert.match(html,/aria-label="消息附件"/); assert.match(html,/参考.png/); assert.match(html,/需求.pdf/);
  assert.match(html,/data-file-icon="image"/); assert.match(html,/data-file-icon="document"/);
  assert(!html.includes('flow-node__detail'));
});

test('时间流保留时间与耗时，分类逐次卡和展开详情均不展示时间', () => {
  const context=makeContext([{id:'timed',type:'commandExecution',status:'completed',details:{command:'node app.mjs',firstObservedAt:1000,startedObservedAt:1000,completedObservedAt:3500}}]);
  const html=render(context);
  assert.match(html,/class="flow-node__time"/); assert.match(html,/dateTime="1970-01-01T00:00:01.000Z"/i);
  assert(!html.includes('完成回执：')); assert(!html.includes('耗时（按回执）'));
  context.ui.details.timed=true;
  assert.match(render(context),/耗时（按回执）：2.50 秒/);
  context.ui.categoryOpen={action:'category:script'};
  assert(!render(context,{mode:'category',expandOccurrences:false}).includes('class="flow-node__time"'));
  const category=render(context,{mode:'category'});
  assert.match(category,/detail:timed/);
  for(const marker of ['flow-node__time','flow-node__timing','flow-node__duration','首次记录：','完成回执：','耗时（按回执）']) assert(!category.includes(marker),marker);
});

test('分类组展开只挂载一份全行内容，并保留其他类别标题', () => {
  const context=makeContext([{id:'read',type:'webSearch',status:'completed',details:{query:'官方文档'}},{id:'run',type:'commandExecution',status:'completed',details:{command:'node app.mjs'}}]);
  context.ui.categoryOpen={action:'category:search'};
  const html=render(context,{mode:'category'});
  assert.equal((html.match(/flow-branch--full/g)||[]).length,1);
  assert.equal((html.match(/class="flow-capability__occurrences[ "]/g)||[]).length,1);
  assert.match(html,/data-flow-node="read"/); assert(!html.includes('data-flow-node="run"'));
  assert.match(html,/flow-capability-grid/); assert(!html.includes('flow-branch__snake'));
  assert.match(html,/脚本与代码/);
});

test('消息身份不重复充当工具标签，真实文件操作保留来源', () => {
  const context=makeContext([{id:'change',type:'fileChange',status:'completed',details:{path:'a.ts'}}]);
  const html=render(context,{streaming:false});
  assert(!html.includes('flow-node__category')); assert.match(html,/flow-node__source[^>]*title="引擎"/);
  assert.match(html,/已完成/); assert.match(html,/title="文件操作"/);
});

test('终端技能MCP来源在节点保留，包括按工具分组的节点', () => {
  const context=makeContext([
    {id:'cat',type:'commandExecution',status:'completed',details:{command:'cat a.ts'}},
    {id:'skill',type:'commandExecution',status:'completed',details:{command:'cat C:/Users/a/.codex/skills/.system/pdf/SKILL.md'}},
    {id:'mcp',type:'mcpToolCall',status:'completed',details:{serverName:'Figma',tool:'get_design_context'}},
  ]);
  const html=render(context); assert.match(html,/flow-node__source[^>]*title="终端"/); assert.match(html,/系统技能/); assert.match(html,/Figma · MCP/);
  context.ui.grouping='tool';
  context.ui.categoryOpen={tool:groupFlowNodes(buildFlowNodes(context,context.steps,[],{streaming:true}),'category','tool').find(group=>group.title.includes('Figma')).id};
  const toolHtml=render(context,{mode:'category'}); assert(!toolHtml.includes('flow-node__source')); assert.match(toolHtml,/Figma · MCP/); assert.match(toolHtml,/读取设计稿/);
});

test('流程中的授权执行文件与提问使用不同语义图标', () => {
  const context=makeContext([
    {id:'allow',type:'interaction',status:'in_progress',details:{interactionKind:'command_approval',title:'允许命令'}},
    {id:'run',type:'commandExecution',status:'in_progress',details:{command:'node app.mjs'}},
    {id:'edit',type:'fileChange',status:'in_progress',details:{path:'a.ts'}},
    {id:'delete',type:'fileChange',status:'in_progress',details:{path:'old.ts',changeType:'deleted'}},
    {id:'ask',type:'interaction',status:'in_progress',details:{interactionKind:'async_question',title:'选择方案'}},
  ]);
  const html=render(context);
  for(const [id,kind] of [['allow','approval'],['run','terminal'],['edit','edit'],['delete','remove'],['ask','question']]){
    const card=html.match(new RegExp(`<article[^>]*data-flow-node="${id}"[\\s\\S]*?<\/article>`))[0];
    assert.match(card,new RegExp(`data-process-icon="${kind}"`));
  }
});

test('分类流提供三维选择器，并从本轮状态恢复资源分组与选中详情', () => {
  const context=makeContext([{id:'read',type:'commandExecution',status:'completed',details:{command:'cat src/a.ts'}}]);
  context.ui.grouping='resource'; context.ui.selectedNodeId='read'; context.ui.details.read=true;
  context.ui.categoryOpen={resource:groupFlowNodes(buildFlowNodes(context,context.steps,[],{streaming:true}),'category','resource').find(group=>group.nodes.some(node=>node.id==='read')).id};
  const html=render(context,{mode:'category'});
  assert.match(html,/aria-label="查看方式"/); assert.match(html,/>按能力类别</); assert.match(html,/>按执行通道</); assert.match(html,/>按项目\/仓库</);
  assert.match(html,/value="resource" selected/); assert.match(html,/data-flow-group="resource:/); assert.match(html,/detail:read/);
  assert(!render(context).includes('aria-label="查看方式"'));
});

test('处理过程折叠时仍有待处理入口，展开后回答表单只有一份', () => {
  const question={id:'question',type:'interaction',status:'in_progress',details:{interactionKind:'async_question',questions:[{title:'选择方案',options:['A','B']}]}};
  const context=makeContext([question]); context.ui.panelExpanded=false;
  const props={steps:[question],flowContext:context,settled:false,sessionId:'s',canAnswerAsyncQuestion:true,onAsyncQuestionAnswer:async()=>{}};
  const closed=renderToStaticMarkup(React.createElement(ProcessSteps,props));
  assert.match(closed,/需要你处理/); assert.match(closed,/查看并处理/);
  context.ui.panelExpanded=true;
  const open=renderToStaticMarkup(React.createElement(ProcessSteps,props));
  assert.equal((open.match(/>提交回答<\/button>/g)||[]).length,1);
  assert.match(open,/选择方案/);
});

test('本轮结束后异步问题仍展示题目选项和单份回答卡片，普通授权不恢复按钮', () => {
  const question={id:'after-question',type:'interaction',status:'in_progress',details:{interactionKind:'async_question',questions:[{title:'主表沿用现有频次？',options:['沿用现有频次','新增监控']}]}};
  const context=makeContext([question]); context.ui.panelExpanded=true;
  const props={steps:[question],flowContext:context,settled:true,sessionId:'s',canAnswerAsyncQuestion:true,onAsyncQuestionAnswer:async()=>{}};
  const html=renderToStaticMarkup(React.createElement(ProcessSteps,props));
  assert.match(html,/主表沿用现有频次/); assert.match(html,/沿用现有频次/); assert.match(html,/新增监控/);
  assert.equal((html.match(/>提交回答<\/button>/g)||[]).length,1);
  assert(!html.includes('本次执行已结束，此请求未确认完成'));
  const answered=renderToStaticMarkup(React.createElement(ProcessSteps,{...props,answeredAsyncQuestionIds:new Set([question.id]),asyncQuestionAnswers:new Map([[question.id,'沿用现有频次']]),full:true}));
  assert.match(answered,/已回答/); assert(!answered.includes('>提交回答</button>'));
  const approval={...question,id:'old-approval',details:{interactionKind:'command_approval',title:'旧授权'}};
  const oldContext=makeContext([approval]); oldContext.ui.panelExpanded=true;
  const old=renderToStaticMarkup(React.createElement(ProcessSteps,{...props,steps:[approval],flowContext:oldContext}));
  assert.match(old,/本次执行已结束，此请求未确认完成/);
});

test('已结束授权在异步问题前面时，仅可补答的问题计入待处理提示', () => {
  const approval={id:'expired-first',type:'interaction',status:'in_progress',details:{interactionKind:'command_approval',title:'已结束的授权'}};
  const question={id:'async-next',type:'interaction',status:'in_progress',details:{interactionKind:'async_question',questions:[{title:'待补充回答的问题',options:['继续','取消']}]}};
  const steps=[approval,question];
  const context=makeContext(steps); context.ui.panelExpanded=true;
  const html=renderToStaticMarkup(React.createElement(ProcessSteps,{steps,flowContext:context,settled:true,sessionId:'s',canAnswerAsyncQuestion:true,onAsyncQuestionAnswer:async()=>{}}));
  assert.match(html,/需要你处理 · 1 项回答或授权/);
  assert(!html.includes('需要你处理 · 2 项'));
  assert.match(html,/本次执行已结束，此请求未确认完成/);
  assert.match(html,/待补充回答的问题/);
  assert.equal((html.match(/>提交回答<\/button>/g)||[]).length,1);
});

test('计划事件仍在图中，最新计划面板独立位于处理内容底部', () => {
  const plan={id:'plan',type:'plan',status:'in_progress',details:{plan:[{step:'检查',status:'completed'},{step:'验证',status:'inProgress'}]}};
  const context=makeContext([plan]); context.ui.panelExpanded=true;
  assert.match(render(context),/更新执行计划/); assert.match(render(context),/已记录/);
  const html=renderToStaticMarkup(React.createElement(ProcessSteps,{steps:[plan],flowContext:context,settled:false}));
  assert.equal((html.match(/aria-label="计划完成进度"/g)||[]).length,1);
  assert(html.indexOf('process-plan-dock')>html.indexOf('process-timeline__content'));
  assert.match(html,/1\/2/);
});

test('已结束或已决议交互不再弹出待处理入口', () => {
  for(const settled of [false,true]){
    const question={id:'resolved',type:'interaction',status:'in_progress',details:{resolvedAction:'accept',interactionKind:'command_approval'}};
    const context=makeContext([question]); context.ui.panelExpanded=true;
    const html=renderToStaticMarkup(React.createElement(ProcessSteps,{steps:[question],flowContext:context,settled}));
    assert(!html.includes('需要你处理'));
  }
});

test('回答进入交付队列即移除提醒，保留交付卡片且取消后恢复提醒', () => {
  const question={id:'live-question',type:'interaction',status:'in_progress',details:{interactionKind:'async_question',questions:[{title:'选择交付方式',options:['继续']}]}};
  const approval={id:'live-approval',type:'interaction',status:'in_progress',details:{interactionKind:'command_approval',title:'允许命令'}};
  const steps=[question,approval];
  const context=makeContext(steps); context.ui.panelExpanded=true;
  const props={steps,flowContext:context,settled:false,sessionId:'s',canAnswerAsyncQuestion:true,full:true};
  // SSR reads Zustand's initial snapshot; populate it with each server-pushed state.
  const snapshot=panelCompiled.exports.useSessionFollowupStore.getInitialState();
  const renderPanel=()=>renderToStaticMarkup(React.createElement(ProcessSteps,props));
  try {
    assert.match(renderPanel(),/需要你处理 · 2 项/);
    for(const state of ['received','steering','steered','queued','dispatching','delivered','paused','uncertain']) {
      snapshot.bySession.s=[{id:'answer',sessionId:'s',replyToAsyncQuestionId:question.id,state,content:'继续'}];
      const html=renderPanel();
      assert.match(html,/需要你处理 · 1 项/);
      assert.match(html,/回答：继续/);
      props.settled=true;
      assert(!renderPanel().includes('需要你处理'));
      props.settled=false;
    }
    snapshot.bySession.s=[{id:'cancelled-answer',replyToAsyncQuestionId:question.id,state:'cancelled'}];
    assert.match(renderPanel(),/需要你处理 · 2 项/);
    snapshot.bySession.s=[{id:'other-answer',replyToAsyncQuestionId:'other-question',state:'queued'}];
    assert.match(renderPanel(),/需要你处理 · 2 项/);
    snapshot.bySession.other=snapshot.bySession.s;
    delete snapshot.bySession.s;
    assert.match(renderPanel(),/需要你处理 · 2 项/);
  } finally {
    delete snapshot.bySession.s;
    delete snapshot.bySession.other;
  }
});

test('折叠时多问题按各自回答计数，取消后重答不受旧记录影响', () => {
  const question=id=>({id,type:'interaction',status:'in_progress',details:{interactionKind:'async_question',questions:[{title:id,options:['继续']}]}});
  const steps=[question('first-question'),question('second-question')];
  const context=makeContext(steps); context.ui.panelExpanded=false;
  const snapshot=panelCompiled.exports.useSessionFollowupStore.getInitialState();
  const props={steps,flowContext:context,settled:false,sessionId:'s'};
  const renderPanel=()=>renderToStaticMarkup(React.createElement(ProcessSteps,props));
  try {
    assert.match(renderPanel(),/需要你处理 · 2 项/);
    snapshot.bySession.s=[
      {id:'old-answer',replyToAsyncQuestionId:steps[0].id,state:'cancelled'},
      {id:'new-answer',replyToAsyncQuestionId:steps[0].id,state:'queued'},
    ];
    const partial=renderPanel();
    assert.match(partial,/需要你处理 · 1 项/);
    assert(!partial.includes('process-timeline__panel'));
    snapshot.bySession.s.push({id:'second-answer',replyToAsyncQuestionId:steps[1].id,state:'received'});
    assert(!renderPanel().includes('需要你处理'));
    // The saved reply takes over before the transient delivery record disappears.
    props.answeredAsyncQuestionIds=new Set(steps.map(step=>step.id));
    delete snapshot.bySession.s;
    assert(!renderPanel().includes('需要你处理'));
  } finally {
    delete snapshot.bySession.s;
  }
});

test('终态不保留运行中动效，明确提示缺少完成结果；类型通过文字与属性标识', () => {
  const context=makeContext([{id:'run',type:'commandExecution',status:'in_progress',details:{command:'node job.mjs'}}]);
  const html=render(context,{streaming:false});
  assert(!html.includes('flow-node--running')); assert(!html.includes('process-flow__live-dot'));
  assert.match(html,/结果未确认/); assert.match(html,/请查看原始记录/); assert.match(html,/data-flow-category="execution"/);
  assert.match(html,/title="脚本与代码"/); assert(!html.includes('flow-node__category'));
});

test('离屏暂停仅作用于持续动效，不再把淡入内容冻结在半透明状态', () => {
  const css=readFileSync(new URL('../../styles/process-flow.css',import.meta.url),'utf8');
  const pause=css.match(/[^{}]+\{[^{}]*animation-play-state:\s*paused[^{}]*\}/g)||[];
  assert(pause.length);
  assert(pause.every(rule=>!rule.includes('] *') && !rule.includes('.flow-branch__nodes') && !rule.includes('.flow-node__detail')));
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/border-inline-start-color:\s*var\(--flow-type\)/);
  assert.match(css,/\.process-plan-dock\s*\{\s*max-height:\s*28vh/);
});

test('无活跃工具时持续显示处理中提示，不把没有新事件描述成思考或结束', () => {
  const html = render(makeContext());
  assert.match(html, /process-flow__activity/); assert.match(html, /暂未收到新的可展示事件/);
  assert(!html.includes('正在思考')); assert(!html.includes('本次回复已完成'));
  assert(!render(makeContext(), {streaming:false,outcome:'completed'}).includes('process-flow__live-dot'));
});

test('状态栏展示实际当前动作，停止与恢复状态优先于旧工具节点', () => {
  const context=makeContext([{id:'read',type:'commandExecution',status:'in_progress',details:{command:'cat src/main.ts'}}]);
  assert.match(render(context), /当前：查看文件/);
  assert.match(render(context), /src\/main.ts/);
  for (const [state,label,detail] of [['stopping','停止中','等待引擎确认停止结果'],['recovering','恢复中','恢复连接与执行状态'],['awaiting_action','等待回答','等待用户回答或授权']]) {
    const html=render(context,{runtimeStatus:{state,label}});
    assert.match(html,new RegExp(label)); assert.match(html,new RegExp(detail));
  }
});

test('千步活跃流程仅挂载当前分段，保留此前记录展开入口', () => {
  const steps = Array.from({length:1000},(_,i)=>({ id:`op-${i}`,type:'commandExecution',status:i===999?'in_progress':'completed',details:{command:'node script.mjs'} }));
  const html = render(makeContext(steps));
  assert.equal((html.match(/data-flow-node=/g)||[]).length,5);
  assert.match(html,/还有 996 项较早记录/); assert.match(html,/class="flow-history-toggle"/);
  assert.match(html,/data-flow-node="op-999"/);
  assert(!html.includes('data-flow-node="op-0"'));
});

test('已完成流程默认展示最近五项，较早记录折叠且细节不提前挂载', () => {
  const steps = Array.from({length:100},(_,i)=>({id:`op-${i}`,type:'commandExecution',status:'completed',details:{command:'node script.mjs'}}));
  const html = render(makeContext(steps));
  assert.equal((html.match(/data-flow-node=/g)||[]).length,5);
  assert.match(html,/还有 96 项较早记录/); assert(!html.includes('detail:op-'));
  assert.match(html,/data-flow-node="op-99"/);
  assert(!html.includes('data-flow-node="op-0"'));
});

test('分类视图保留单份节点，展开偏好与详情偏好可恢复', () => {
  const context=makeContext([{id:'search',type:'webSearch',status:'completed',details:{query:'官方文档'}}]);
  context.ui.categoryOpen={action:'category:search'};
  context.ui.details.search=true;
  const html=render(context,{mode:'category'});
  assert.equal((html.match(/data-flow-node="search"/g)||[]).length,1);
  assert.match(html,/detail:search/); assert.match(html,/展开查看每次记录/);
});

test('时间流默认严格最近五条，较早待处理失败及选中项均折叠', () => {
  const steps=Array.from({length:20},(_,i)=>({id:`keep-${i}`,type:'commandExecution',status:i===0?'in_progress':i===1?'failed':'completed',details:{command:'node task.mjs'}}));
  const context=makeContext(steps);context.ui.selectedNodeId='keep-0';
  const html=render(context);
  assert(!html.includes('data-flow-node="keep-0"')); assert(!html.includes('data-flow-node="keep-1"'));
  assert.equal((html.match(/data-flow-node=/g)||[]).length,5);assert.match(html,/回到当前/);
  assert.match(html,/data-flow-node="keep-19"/);
  assert(!html.includes('data-flow-node="keep-2"'));
  context.ui.expanded['time:earlier']=true;
  const expanded=render(context);assert.match(expanded,/data-flow-node="keep-0"/);assert.match(expanded,/data-flow-node="keep-1"/);assert(!expanded.includes('项已完成'));
});

test('时间流展开较早记录的选择仅保存在当前消息上下文', () => {
  const steps=Array.from({length:20},(_,i)=>({id:`older-${i}`,type:'commandExecution',status:'completed',details:{command:'node task.mjs'}}));
  const context=makeContext(steps); context.ui.expanded['time:earlier']=true;
  assert.match(render(context),/data-flow-node="older-0"/);
  assert.match(render(context),/已展开较早记录/);
  assert.match(render(context),/flow-history-toggle__action">只看最近/);
  assert(!render(makeContext(steps)).includes('data-flow-node="older-0"'));
});

test('缺失记录时间时不显示时间占位，展开详情也不显示未记录提示', () => {
  const context=makeContext([{id:'no-time',type:'commandExecution',status:'completed',details:{command:'node task.mjs'}}]);
  context.root.recordedAt=undefined; context.ui.details['no-time']=true;
  const html=render(context);
  assert(!html.includes('时间未记录'));
  assert(!html.includes('class="flow-node__time"'));
});

test('大量未确认节点也只默认显示五条，手动展开后再保留分页入口', () => {
  const steps=Array.from({length:100},(_,i)=>({id:`pending-${i}`,type:'commandExecution',status:'in_progress',details:{command:'node task.mjs'}}));
  const context=makeContext(steps),html=render(context);
  assert.match(html,/data-flow-node="pending-99"/);
  assert.equal((html.match(/data-flow-node=/g)||[]).length,5);
  context.ui.expanded['time:earlier']=true;
  const expanded=render(context);assert.match(expanded,/展开此前 40 项/);assert.equal((expanded.match(/data-flow-node="pending-/g)||[]).length,40);
});

test('展开大量交错历史组默认仍在最近分段，提供向前展开入口', () => {
  const steps=Array.from({length:100},(_,i)=>({id:`history-${i}`,type:i%2?'webSearch':'commandExecution',status:'completed',details:i%2?{query:'文档'}:{command:'node task.mjs'}}));
  const context=makeContext(steps); context.ui.expanded['time:earlier']=true;
  const html=render(context);
  assert.match(html,/data-flow-node="history-99"/);
  assert.match(html,/展开此前 40 组记录/);
});

test('用户内容与工具名称按纯文本转义，界面不执行其中的标记', () => {
  const context=makeContext(); context.root.content='<script>alert(1)</script>'; context.ui.details['input:root']=true;
  const html=render(context);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert(!html.includes('<script>alert'));
});

test('停止与异常终态保留可读文字和对应状态', () => {
  for(const [outcome,label] of [['stopped','已停止'],['failed','失败']]){
    const html=render(makeContext(),{streaming:false,outcome});
    assert.match(html,new RegExp(label)); assert.match(html,new RegExp(`flow-node--${outcome}`));
    assert.match(html,/data-flow-motion="off"/);
  }
});

test('显式子任务分支可按保存状态展开并显示各自结果', () => {
  const context=makeContext([{id:'agents',type:'collabAgentToolCall',status:'completed',details:{agentResults:[{threadId:'a',status:'completed',message:'检查完成'},{threadId:'b',status:'errored',message:'检查失败'}]}}]);
  context.ui.expanded['children:agents']=true;
  const html=render(context);
  assert.match(html,/2 个子任务/); assert.match(html,/data-flow-node="agents:agent:a"/); assert.match(html,/flow-node--failed/);
});

test('运行中或选中的子任务不自动突破时间流五条，明确展开后才显示', () => {
  const context=makeContext([
    ...Array.from({length:4},(_,index)=>({id:`strict-${index}`,type:'commandExecution',status:'completed',details:{command:'node task.mjs'}})),
    {id:'agents',type:'collabAgentToolCall',status:'completed',details:{agentResults:[{threadId:'a',status:'running'}]}},
  ]);
  context.ui.selectedNodeId='agents:agent:a';
  const html=render(context);assert.equal((html.match(/data-flow-node=/g)||[]).length,5);assert(!html.includes('data-flow-node="agents:agent:a"'));
  context.ui.expanded['children:agents']=true;
  assert.match(render(context),/data-flow-node="agents:agent:a"/);
});

test('恢复手动展开的分类时定位到选中节点所在分段', () => {
  const context=makeContext(Array.from({length:200},(_,i)=>({id:`op-${i}`,type:'commandExecution',status:'completed',details:{command:'node script.mjs'}})));
  context.ui.selectedNodeId='op-150'; context.ui.details['op-150']=true;
  context.ui.categoryOpen={action:'category:script'};
  const html=render(context,{mode:'category'});
  assert.match(html,/data-flow-node="op-150"/); assert.match(html,/detail:op-150/);
  assert.equal((html.match(/data-flow-node=/g)||[]).length,20);
});

test('千步交错类别也按组分段，避免小组过多绕过渲染上限', () => {
  const steps=Array.from({length:1000},(_,i)=>({id:`mixed-${i}`,type:i%2?'webSearch':'commandExecution',status:i===999?'in_progress':'completed',details:i%2?{query:'文档'}:{command:'node script.mjs'}}));
  const html=render(makeContext(steps));
  assert.equal((html.match(/data-flow-node=/g)||[]).length,5);
  assert.match(html,/data-flow-node="mixed-999"/); assert.match(html,/还有 996 项较早记录/);
  assert(!html.includes('data-flow-node="mixed-0"'));
});

test('时间轨道在同组及跨组节点之间使用真实相邻节点色调', () => {
  const context=makeContext([
    {id:'tone-git',type:'commandExecution',status:'completed',details:{command:'git status'}},
    {id:'tone-skill',type:'commandExecution',status:'completed',details:{command:'cat ai/skills/pdf/SKILL.md'}},
    {id:'tone-file',type:'commandExecution',status:'completed',details:{command:'cat src/a.ts'}},
    {id:'tone-mcp',type:'mcpToolCall',status:'completed',details:{server:'Figma',tool:'get_design_context'}},
  ]);
  const html=render(context);
  for(const [id,next] of [['tone-git','skill'],['tone-skill','file'],['tone-file','mcp'],['tone-mcp','mcp']]){
    const card=html.match(new RegExp(`<article[^>]*data-flow-node="${id}"[\\s\\S]*?<\\/article>`))[0];
    assert(card.includes(`class="flow-node__rail" data-flow-style="${next}"`));
  }
});

test('历史分页截断时轨道收口，不把隐藏的同组记录跨接到后一组', () => {
  const context=makeContext([
    ...Array.from({length:60},(_,index)=>({id:`cut-${index}`,type:'commandExecution',status:'completed',details:{command:'node task.mjs'}})),
    {id:'after-cut',type:'webSearch',status:'completed',details:{query:'文档'}},
  ]);
  context.ui.expanded['time:earlier']=true;context.ui.selectedNodeId='cut-0';
  const html=render(context),card=id=>html.match(new RegExp(`<article[^>]*data-flow-node="${id}"[\\s\\S]*?<\\/article>`))[0];
  assert(!card('cut-38').includes('data-flow-end'));assert.match(card('cut-39'),/data-flow-end="true"/);
  assert(!html.includes('data-flow-node="cut-40"'));assert.match(html,/data-flow-node="after-cut"/);
});

test('后续输入位置不明时不画指向它的连续轨道', () => {
  const context=makeContext([{id:'before-gap',type:'commandExecution',status:'completed',details:{command:'node task.mjs'}}]);
  context.inputs=[{id:'unknown-position',content:'补充',delivery:'已保存',state:'completed',positionKnown:false}];
  const html=render(context),card=html.match(/<article[^>]*data-flow-node="before-gap"[\s\S]*?<\/article>/)[0];
  assert.match(card,/flow-node__rail" data-flow-style="script" data-flow-end="true"/);
});

test('分类折叠汇总保留子任务的失败与运行状态', () => {
  const context=makeContext([{id:'agents',type:'collabAgentToolCall',status:'completed',details:{agentResults:[{threadId:'a',status:'running'},{threadId:'b',status:'errored'}]}}]);
  context.ui.expanded['category:collaboration']=false;
  const html=render(context,{mode:'category'});
  assert.match(html,/1 项待完成/); assert.match(html,/1 项失败/); assert.match(html,/回到当前/);
  assert(!html.includes('data-flow-node="agents"'));
});

test('较后位置的子任务可恢复选中，单次仍只挂载二十个子节点', () => {
  const context=makeContext([{id:'agents',type:'collabAgentToolCall',status:'completed',details:{agentResults:Array.from({length:100},(_,i)=>({threadId:String(i),status:i===0?'running':'completed'}))}}]);
  context.ui.selectedNodeId='agents:agent:90';
  context.ui.categoryOpen={action:'category:collaboration'};
  context.ui.expanded['children:agents']=true;
  const html=render(context,{mode:'category'});
  assert.match(html,/data-flow-node="agents:agent:90"/);
  assert.match(html,/展开此前子任务/);
  assert.equal((html.match(/data-flow-node="agents:agent:/g)||[]).length,20);
});

test('排队补充不会被当成用户待回答，也不抢占当前操作定位', () => {
  const context=makeContext();
  context.inputs=[{id:'queued',label:'用户补充要求',content:'下一轮再处理',delivery:'等待下一轮处理',state:'waiting',positionKnown:true}];
  const html=render(context,{runtimeStatus:{state:'processing',label:'处理中'}});
  assert.match(html,/等待下一轮处理/); assert.match(html,/暂未收到新的可展示事件/);
  assert(!html.includes('等待用户回答或授权')); assert(!html.includes('回到当前'));
});

test('三种分类默认全部折叠，活跃或选中节点也不自动展开', () => {
  for(const grouping of ['action','tool','resource']){
    const context=makeContext([{id:'run',type:'commandExecution',status:'in_progress',details:{command:'cat a.ts'}}]);
    context.ui.grouping=grouping; context.ui.selectedNodeId='run';
    const html=render(context,{mode:'category'});
    assert(!html.includes('data-flow-node=')); assert.match(html,/回到当前/); assert.match(html,/项待完成/);
  }
});
