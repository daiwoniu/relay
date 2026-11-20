import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskRegistryAdapter } from './task-registry-adapter.js';
import { readTaskRegistry } from './task-registry-reader.js';
import { TaskRegistryComposition } from './task-registry-composition.js';
import { FeishuProjectClient } from '../integrations/feishu/client.js';
import { projectFeishuSnapshot } from './feishu-source.js';
import { projectResponsibility } from '../integrations/feishu/responsibility.js';

test('orphan run directories retain task title and test evidence without inventing a central ledger',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-orphan-tests-'));
 try{
  const runPath=path.join(root,'tasks','orphan','runs','contract-01');await fs.mkdir(runPath,{recursive:true});
  await fs.writeFile(path.join(root,'tasks','orphan','README.md'),'# 应用依赖接入\n');
  await fs.writeFile(path.join(root,'tasks','task-registry.json'),JSON.stringify({schema_version:1,tasks:{}}));
  await fs.writeFile(path.join(runPath,'status.json'),JSON.stringify({run_id:'contract-01',status:'succeeded',exit_code:0}));
  await fs.writeFile(path.join(runPath,'run.log'),'JUnit version 4.13.2\nOK (13 tests)\n');
  const [orphan]=await new TaskRegistryAdapter(root,'test').runs();
  assert.equal(orphan.taskId,null);assert.equal(orphan.taskContext?.title,'应用依赖接入');assert.equal(orphan.taskContext?.association,'unregistered');
  assert.equal(orphan.testResult?.total,13);assert.equal(orphan.detailFilePath,path.join(runPath,'run.log'));
  await fs.writeFile(path.join(root,'tasks','task-registry.json'),JSON.stringify({schema_version:1,tasks:{registered:{kind:'task',task_path:'tasks/orphan',title:'登记标题'}}}));
  const [registered]=await new TaskRegistryAdapter(root,'test').runs();assert.equal(registered.taskId,'registered');assert.equal(registered.taskContext?.association,'registered');
  await fs.writeFile(path.join(root,'tasks','task-registry.json'),JSON.stringify({schema_version:1,tasks:{one:{kind:'task',task_path:'tasks/orphan'},two:{kind:'task',task_path:'tasks/orphan'}}}));
  const [ambiguous]=await new TaskRegistryAdapter(root,'test').runs();assert.equal(ambiguous.taskId,null);assert.equal(ambiguous.taskContext?.association,'ambiguous');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('verified linked stories fetched for enrichment also provide parent identity without creating personal responsibility',async()=>{
  const catalog=[{type_key:'story',name:'需求',api_name:'story'},{type_key:'issue',name:'缺陷',api_name:'issue'}],space={project_key:'space',simple_name:'demo'};
  const issue={id:'1000000002',project_key:'space',work_item_type_key:'issue',pattern:'State',name:'缺陷',fields:[{field_key:'issue_operator',field_value:'me'},{field_key:'role_owners',field_value:[]},{field_key:'stories',field_value:['1000000001']}],work_item_status:{state_key:'OPEN',is_archived_state:false}};
  const story={id:'1000000001',project_key:'space',work_item_type_key:'story',name:'所属需求',fields:[{field_key:'owner',field_value:'other'},{field_key:'role_owners',field_value:[]}],work_item_status:{is_archived_state:false},workflow_infos:{workflow_nodes:[{id:'n',name:'验收',status:2,owners:['other']}]}};
  const requested:string[][]=[];
  const client={config:{connectionId:'test',scope:'test',projectKey:'space',userKey:'me'},catalog:async()=>catalog,space:async()=>space,
    discover:async()=>{throw Error('already known type must not be rediscovered');},
    details:async(type:string,ids:string[])=>{requested.push(ids);return ids.map(()=>type==='issue'?issue:story);},
    metadata:async()=>[{field_key:'stories'}],users:async()=>new Map([['other','其他人']]),
  } as unknown as FeishuProjectClient;
  const fact=projectResponsibility(issue,[],client,catalog,space);fact.linkedStoryIds=['1000000001'];
  const source=projectFeishuSnapshot({generatedAt:'now',fetchedAt:1,retrievalComplete:true,classificationComplete:true,relationCoverage:'partial',facts:[fact]},'me','space');
  const value=await new TaskRegistryComposition(async()=>({schemaVersion:1,generatedAt:null,tasks:[]}),{ADAPTER_STORY_RELATION_FIELD:'stories'},()=>client,'test').compose(source);
  const parent=value.workbenchItems.find(item=>item.workItemId==='1000000001');
  assert.equal(parent?.title,'所属需求');assert.equal(parent?.participated,false);assert.deepEqual(parent?.currentNodes?.[0].ownerNames,['其他人']);
  assert.equal(value.items.length,1);assert.equal(value.relationCoverage,'partial','business enrichment cannot promote incomplete native relation coverage');
  assert.deepEqual(requested,[['1000000002'],['1000000001']]);
});

test('independent local deliveries share Feishu IDs without merging and Run directories map by task_path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-adapter-'));
  try {
    const runRoot = path.join(root, 'tasks', 'different-directory', 'runs', 'run-one'); await fs.mkdir(runRoot, { recursive: true });
    await fs.writeFile(path.join(runRoot, 'status.json'), JSON.stringify({ run_id: 'run-one', status: 'completed' }));
    const registry = { schema_version: 1, tasks: {
      'delivery-one': { kind: 'task', task_path: 'tasks/different-directory', feishu_work_item_ids: ['1000000001'] },
      'delivery-two': { kind: 'item', feishu_work_item_ids: ['1000000001', '1000000002'] },
    } };
    const file = path.join(root, 'tasks', 'task-registry.json'); await fs.writeFile(file, JSON.stringify(registry));
    const adapter = new TaskRegistryAdapter(root, 'stable');
    const [tasks, runs] = await Promise.all([adapter.registry(), adapter.runs()]);
    assert.equal(tasks.tasks.length, 2); assert.equal(runs[0].taskId, 'delivery-one');
    assert.equal(tasks.tasks[1].kind, 'item'); assert.deepEqual(tasks.tasks[1].diagnostics, []);
    const duplicate={...registry,tasks:{...registry.tasks,duplicate:{kind:'task',task_path:'tasks/different-directory'}}};
    await fs.writeFile(file,JSON.stringify(duplicate));
    const conflicted=await adapter.registry();
    assert(conflicted.tasks.filter(task=>task.taskPath).every(task=>task.diagnostics?.some(message=>message.includes('同一任务目录'))));
    assert.equal((await adapter.runs())[0].taskId,null);
    delete (registry.tasks as Record<string, unknown>)['delivery-one']; await fs.writeFile(file, JSON.stringify(registry));
    assert.equal((await adapter.runs())[0].taskId, null);
    await fs.writeFile(file, JSON.stringify({ schema_version: 2, tasks: {} }));
    await assert.rejects(readTaskRegistry(root), /schema_version/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('association projection opens only the central registry, not README or delivery evidence',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-association-read-'));
  try{
    await fs.mkdir(path.join(root,'tasks','delivery'),{recursive:true});
    await fs.writeFile(path.join(root,'tasks','delivery','README.md'),'# 本地交付\n');
    await fs.writeFile(path.join(root,'tasks','task-registry.json'),JSON.stringify({schema_version:1,tasks:{
      delivery:{kind:'task',task_path:'tasks/delivery',status:'doing',feishu_work_item_ids:['1000000001']},
    }}));
    const open=t.mock.method(fs,'open');
    const value=await new TaskRegistryAdapter(root,'test').associations();
    assert.equal(value.tasks.length,1);assert.deepEqual(value.tasks[0].feishuWorkItemIds,['1000000001']);
    assert.equal(open.mock.callCount(),1);
    assert.equal(String(open.mock.calls[0].arguments[0]),path.join(root,'tasks','task-registry.json'));
    open.mock.restore();
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('repository composition keeps provider payload pure, batches history lookup and preserves failure metadata', async () => {
  const calls: string[] = [];
  const client = new FeishuProjectClient({ connectionId: 'test', projectKey: 'space', userKey: 'me', pluginId: 'plugin', pluginSecret: 'secret', scope: 'a'.repeat(64) }, (async (url, init) => {
    const route = String(url).split('/open_api/')[1]; calls.push(route);
    const data = route === 'authen/plugin_token' ? { token: 'fake' } : route==='user/query'?[{user_key:'other',name:{zh_cn:'其他人'}}]:route === 'projects/detail' ? [{ project_key: 'space', simple_name: 'test' }] : route.endsWith('all-types') ? [{ type_key: 'issue', api_name: 'defect' }]
      : route.endsWith('filter') ? [{ id: '1000000001', project_key: 'space', work_item_type_key: 'issue' }] : [{ id: '1000000001', project_key: 'space', work_item_type_key: 'issue', pattern: 'State', name: '历史缺陷', fields: [{ field_key: 'owner', field_value: 'other' }, { field_key: 'role_owners', field_value: [] }, { field_key: 'issue_operator', field_value: 'other' }], work_item_status: { is_archived_state: true } }];
    return new Response(JSON.stringify({ data, ...(route.endsWith('filter') ? { pagination: { total: 1 } } : {}) }));
  }) as typeof fetch, Date.now, 0);
  const task = { id: 'delivery-a', kind: 'item' as const, title: null, taskPath: null, taskDocumentPath: null, description: null, status: 'doing', horizon: null, nextAction: null, waitingOn: null, statusBasis: null, verification: null, lastVerifiedAt: null, feishuWorkItemIds: ['1000000001', '1000000002'] };
  const registry = { schemaVersion: 1, generatedAt: null, tasks: [task, { ...task, id: 'delivery-b' }] };
  const source = projectFeishuSnapshot({ generatedAt: new Date().toISOString(), fetchedAt: 1000, retrievalComplete: true, classificationComplete: true, relationCoverage: 'not_queried', facts: [] }, 'me');
  const composition = new TaskRegistryComposition(async () => registry, {}, () => client, 'test');
  const result = await composition.compose(source);
  assert.deepEqual(source.localAssociated, []); assert.deepEqual(source.workbenchItems, []);
  assert.equal(result.workbenchItems.length, 1); assert.equal(result.localAssociated.length, 2);
  assert.deepEqual(result.localAssociated[0].localTaskIds, ['delivery-a', 'delivery-b']);
  assert.equal(result.localAssociated[1].verified, false);
  assert.equal(calls.filter(route => route.endsWith('filter')).length, 1); assert.equal(calls.filter(route => route.endsWith('/query')&&route!=='user/query').length, 1);
  assert.equal(calls.filter(route=>route==='user/query').length,1,'assignee names use one separate batch');
  const before = calls.length;
  const stale = await composition.compose({ ...source, stale: true, servedFromCache: true, error: '刷新失败' });
  assert.equal(stale.error, '刷新失败'); assert.equal(stale.stale, true); assert.equal(calls.length, before);
  const history=new TaskRegistryComposition(async()=>({...registry,tasks:registry.tasks.map(task=>({...task,status:'done'}))}),{},()=>client,'test');
  const historical=await history.compose(source);
  assert.equal(calls.length,before,'completed history must not trigger a bulk external scan');
  assert.equal(historical.localAssociated.length,2);
  assert(historical.localAssociated.every(item=>!item.verified));
  const targeted=await history.compose(source,'delivery-a');
  assert.equal(targeted.workbenchItems.length,1);
  assert(calls.length>before,'opening a specific historical delivery may verify its references');
});

test('historical detail queries only the selected delivery and leaves the list cache reusable',async()=>{
  const requested:string[][]=[];
  const detail=(id:string)=>({id,project_key:'space',work_item_type_key:'issue',pattern:'State',fields:[{field_key:'owner',field_value:'other'},{field_key:'role_owners',field_value:[]},{field_key:'issue_operator',field_value:'other'}]});
  const client={config:{connectionId:'test',scope:'test',projectKey:'space',userKey:'me'},
    catalog:async()=>[{type_key:'issue'}],space:async()=>({project_key:'space'}),
    discover:async(ids:string[])=>{requested.push(ids);return new Map(ids.map(id=>[id,'issue']));},
    details:async(_type:string,ids:string[])=>ids.map(detail),
  } as unknown as FeishuProjectClient;
  const task=(id:string,status:string,ref:string)=>({id,status,feishuWorkItemIds:[ref]}) as any;
  const registry={schemaVersion:1,generatedAt:null,tasks:[task('active','doing','1000000001'),task('history','done','1000000002')]};
  const source=projectFeishuSnapshot({generatedAt:'now',fetchedAt:1,retrievalComplete:true,classificationComplete:true,relationCoverage:'not_queried',facts:[]},'me');
  const composition=new TaskRegistryComposition(async()=>registry,{},()=>client,'test');
  await composition.compose(source);
  await composition.compose(source,'history');
  await composition.compose(source);
  assert.deepEqual(requested,[['1000000001'],['1000000002']]);
});

test('supplemented defects share the adapter collaborator rule without adding personal todo items',async()=>{
  let roleQueries=0;
  const ids=['1000000001','1000000002'];
  const client={config:{connectionId:'test',scope:'test',projectKey:'space',userKey:'me'},
    catalog:async()=>[{type_key:'issue'}],space:async()=>({project_key:'space'}),
    discover:async()=>new Map(ids.map(id=>[id,'issue'])),
    details:async()=>ids.map(id=>({id,project_key:'space',work_item_type_key:'issue',pattern:'State',work_item_status:{is_archived_state:false},
      fields:[{field_key:'owner',field_value:'other'},{field_key:'issue_operator',field_value:'other'},{field_key:'role_owners',field_value:[{role:'dynamic_collaborator',owners:['me']}]}]})),
    flowRoles:async()=>{roleQueries++;return[{id:'dynamic_collaborator',name:'协作人',isOwner:false}];},
  } as unknown as FeishuProjectClient;
  const registry={schemaVersion:1,generatedAt:null,tasks:[{id:'delivery',status:'doing',feishuWorkItemIds:ids}] as any};
  const source=projectFeishuSnapshot({generatedAt:'now',fetchedAt:1,retrievalComplete:true,classificationComplete:true,relationCoverage:'not_queried',facts:[]},'me');
  const result=await new TaskRegistryComposition(async()=>registry,{},()=>client,'test').compose(source);
  assert.equal(roleQueries,1);assert.equal(result.workbenchItems.length,2);
  for(const item of result.workbenchItems)assert.deepEqual(item.roleOwnerUserKeys,['me']);
  assert.deepEqual(result.items,[]);assert.deepEqual(source.workbenchItems,[]);
});

test('supplement failure preserves known native links and can recover without a pure snapshot refresh',async()=>{
  let failed=true,catalogCalls=0;
  const client={config:{connectionId:'test',scope:'test',projectKey:'space',userKey:'me'},
    catalog:async()=>{catalogCalls++;if(failed)throw Error('offline');return[{type_key:'issue'}];},
    space:async()=>({project_key:'space'}),discover:async()=>new Map(),
  } as unknown as FeishuProjectClient;
  const registry={schemaVersion:1,generatedAt:null,tasks:[{id:'delivery',status:'doing',feishuWorkItemIds:['1000000001','1000000002']}] as any};
  const source=projectFeishuSnapshot({generatedAt:'now',fetchedAt:1,retrievalComplete:true,classificationComplete:true,relationCoverage:'not_queried',facts:[]},'me');
  source.workbenchItems=[{workItemId:'1000000001',title:'known',url:'https://project.feishu.cn/known',mySubtasks:[]} as any];
  const composition=new TaskRegistryComposition(async()=>registry,{},()=>client,'test');
  const first=await composition.compose(source);
  assert.equal(first.localAssociated[0].verified,true);assert.equal(first.localAssociated[0].title,'known');
  assert.equal(first.localAssociated[1].verified,false);
  failed=false;await composition.compose(source);assert.equal(catalogCalls,2);
});

test('unbound connection performs no lookup and does not associate identical numeric IDs',async()=>{
  const source=projectFeishuSnapshot({generatedAt:'now',fetchedAt:1,retrievalComplete:true,classificationComplete:true,relationCoverage:'not_queried',facts:[]},'me');
  let reads=0;
  const composition=new TaskRegistryComposition(async()=>{reads++;throw Error('must not read');},{},()=>{throw Error('must not connect');});
  const value=await composition.compose(source);
  assert.equal(reads,0);assert.equal(value.associationMeta?.state,'unbound');assert.equal(value.complete,true);
});

test('supplement budget and unique child association preserve native facts',async()=>{
  const source=projectFeishuSnapshot({generatedAt:'now',fetchedAt:1,retrievalComplete:true,classificationComplete:true,relationCoverage:'not_queried',facts:[]},'me');
  source.workbenchItems=[{workItemId:'1',title:'parent',typeKey:'story',mySubtasks:[{id:'2',title:'child'}]} as any];
  const registry={schemaVersion:1,generatedAt:null,tasks:[{id:'delivery',status:'doing',feishuWorkItemIds:['2',...Array.from({length:1001},(_,i)=>String(i+100))]}] as any};
  let discovered=0;
  const client={config:{connectionId:'test',userKey:'me',projectKey:'space'},catalog:async()=>[],space:async()=>({}),discover:async(ids:string[])=>{discovered+=ids.length;return new Map();}} as unknown as FeishuProjectClient;
  const result=await new TaskRegistryComposition(async()=>registry,{},()=>client,'test').compose(source);
  assert.equal(result.complete,true);assert.equal(result.associationMeta?.state,'partial');assert.equal(discovered,1000);
  assert.deepEqual(result.workbenchItems[0].mySubtasks[0].localTaskIds,['delivery']);assert.deepEqual(result.workbenchItems[0].localTaskIds,[]);
  assert.equal(result.localAssociated[0].kind,'subtask');assert.equal(result.localAssociated[0].parentId,'1');
  assert.deepEqual(source.workbenchItems[0].mySubtasks[0].localTaskIds,undefined);
});
