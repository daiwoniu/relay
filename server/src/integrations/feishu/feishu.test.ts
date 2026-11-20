import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadFeishuConfig, type FeishuConfig } from './config.js';
import { FeishuProjectClient, type Row } from './client.js';
import { FeishuResponsibilityService, hasUnverifiedResponsibility, hydrateFactNames, linkedWorkItemIds, projectResponsibility, timestamp } from './responsibility.js';
import { readOperationPage } from './operations.js';
import { FeishuWorkbenchSource, projectFeishuSnapshot } from '../../workspace-console/feishu-source.js';
import { WorkspaceConsoleResponsibilityDtoSchema } from '../../contracts/dto.js';
import { taskRegistryResponsibilityRoles } from '../../workspace-console/task-registry-adapter.js';
import { withFeishuReadBatch } from './read-batch.js';
import { TaskRegistryComposition } from '../../workspace-console/task-registry-composition.js';

const config: FeishuConfig = { connectionId: 'test', projectKey: 'space', userKey: 'me', pluginId: 'plugin', pluginSecret: 'secret', scope: 'a'.repeat(64) };
const catalog = [{ type_key: 'story', api_name: 'requirement', name: '需求', is_disable: 2 }, { type_key: 'issue', api_name: 'defect', name: '缺陷', is_disable: 2 }];
const space = { project_key: 'space', simple_name: 'test' };
test('optional item and child ordering timestamps preserve native evidence without substituting parent update time',()=>{
  const {client}=fake(()=>({data:[]}));
  const created=1795142276713,updated=1795142303345;
  const fact=projectResponsibility(item({created_at:created,updated_at:updated}),[{work_item_id:'1000000001',node_id:'node',sub_task:{id:'1000000002',name:'子任务',owners:['me'],passed:false,created_at:created,updated_at:updated}}],client,catalog,space);
  assert.equal(fact.createdAt,new Date(created).toISOString());assert.equal(fact.mySubtasks[0].createdAt,new Date(created).toISOString());assert.equal(fact.mySubtasks[0].updatedAt,new Date(updated).toISOString());
  const source=projectFeishuSnapshot({generatedAt:new Date(updated).toISOString(),fetchedAt:updated,retrievalComplete:true,classificationComplete:true,relationCoverage:'not_queried',facts:[fact]},'me','space');
  const dto=WorkspaceConsoleResponsibilityDtoSchema.parse(source);
  assert.equal(dto.workbenchItems[0].mySubtasks[0].createdAt,fact.mySubtasks[0].createdAt);assert.equal(dto.items[0].createdAt,fact.createdAt);
  const missing=projectResponsibility(item({created_at:'invalid',updated_at:updated}),[],client,catalog,space);
  assert.equal(missing.createdAt,null);assert.equal(missing.updatedAt,new Date(updated).toISOString());
});
test('provider and business composition share one read without rediscovering or refetching known items',async()=>{
  const story=item(), issue=item({id:'1000000002',work_item_type_key:'issue',pattern:'State',work_item_status:{state_key:'OPEN',is_archived_state:false},fields:[
    {field_key:'owner',field_value:'other'},{field_key:'issue_operator',field_value:'me'},{field_key:'role_owners',field_value:[]},{field_key:'linked',field_value:['1000000001']},
  ]});
  const {client,calls}=fake((route,body)=>{
    if(route.endsWith('all-types'))return{data:catalog};
    if(route==='projects/detail')return{data:{space}};
    if(route.endsWith('filter'))return{data:[story,issue],pagination:{total:2}};
    if(route.endsWith('subtask/search'))return{data:[],pagination:{total:0}};
    if(route.endsWith('/meta'))return{data:[{field_key:'linked',field_name:'关联需求'}]};
    if(route.endsWith('/workflow/query'))return{data:{state_flow_nodes:[{id:'OPEN',name:'待处理'}]}};
    if(route==='user/query')return{data:[]};
    return{data:body.work_item_ids.map((id:string)=>id===story.id?story:issue)};
  });
  let providerCalls=0;
  await withFeishuReadBatch(async()=>{
    const native=await new FeishuResponsibilityService(client,Date.now,()=>[],'关联需求').load();
    const source=projectFeishuSnapshot(native,'me','space');providerCalls=calls.length;
    const composed=await new TaskRegistryComposition(async()=>({schemaVersion:1,generatedAt:null,tasks:[]}),{ADAPTER_STORY_RELATION_FIELD:'关联需求'},()=>client,'test').compose(source);
    assert.deepEqual(composed.items.find(item=>item.workItemId===issue.id)?.linkedStoryIds,[story.id]);
    assert.equal(calls.length,providerCalls,'known business enrichment must reuse the just-fetched metadata and details');
  });
  assert.equal(calls.filter(call=>call.route.endsWith('filter')).length,1);
  assert.equal(calls.filter(call=>call.route.endsWith('/meta')).length,1);
  assert.equal(calls.filter(call=>call.route.endsWith('/query')&&!call.route.endsWith('/workflow/query')&&call.route!=='user/query').length,2);
});
test('native relation fields distinguish absent, empty and verified IDs; malformed links cannot become roots',()=>{
  assert.equal(linkedWorkItemIds({fields:[]},'story'),null);
  assert.deepEqual(linkedWorkItemIds({fields:[{field_key:'story',field_value:[]}]},'story'),[]);
  assert.deepEqual(linkedWorkItemIds({fields:[{field_key:'story',field_value:[7064669599,'7064669599']}]},'story'),['7064669599']);
  for(const value of [7064669599,'7064669599'])assert.deepEqual(linkedWorkItemIds({fields:[{field_key:'story',field_value:value}]},'story'),['7064669599']);
  for(const value of [0,-1,1.2,Number.MAX_SAFE_INTEGER+1,'',true,{id:'7064669599'}])assert.throws(()=>linkedWorkItemIds({fields:[{field_key:'story',field_value:value}]},'story'));
  assert.throws(()=>linkedWorkItemIds({fields:[{field_key:'story',field_value:[{id:'7064669599'}]}]},'story'));
});
const item = (extra: Row = {}): Row => ({ id: '1000000001', project_key: 'space', work_item_type_key: 'story', name: '测试',
  pattern: 'Node', work_item_status: { state_key: 'active', is_archived_state: false },
  fields: [{ field_key: 'owner', field_value: 'other' }, { field_key: 'role_owners', field_value: [] }],
  workflow_infos: { workflow_nodes: [{ id: 'node', name: '开发', status: 2, owners: ['me'] }] }, ...extra });
function fake(handler: (route: string, body: Row) => Row, overrides: Partial<FeishuConfig> = {}) {
  const calls: Array<{ route: string; body: Row; method: string }> = [];
  const client = new FeishuProjectClient({ ...config, ...overrides }, (async (url, init) => {
    const route = String(url).split('/open_api/')[1], body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ route, body, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(route === 'authen/plugin_token' ? { data: { token: 'private-token' } } : handler(route, body)));
  }) as typeof fetch, () => 1_800_000_000_000, 0);
  return { client, calls };
}

test('native source projects verified story links and closed personal issue history with explicit relation coverage',async()=>{
  let present=true;
  const {client}=fake(route=>{
    const issue=item({work_item_type_key:'issue',pattern:'State',work_item_status:{state_key:'CLOSED',is_archived_state:true,updated_at:1795142276713},
      fields:[{field_key:'issue_operator',field_value:'me'},...(present?[{field_key:'_field_linked_story',field_value:7064669599}]:[])]});
    if(route.endsWith('all-types'))return{data:catalog};
    if(route==='projects/detail')return{data:{space}};
    if(route.endsWith('filter'))return{data:[issue],pagination:{total:1}};
    if(route.endsWith('subtask/search'))return{data:[],pagination:{total:0}};
    if(route.endsWith('/meta'))return{data:[{field_key:'_field_linked_story',field_name:'关联需求'}]};
    return{data:[issue]};
  });
  const load=()=>new FeishuResponsibilityService(client,Date.now,()=>[],'关联需求').load();
  const native=await load();assert.equal(native.relationCoverage,'complete');
  const projected=projectFeishuSnapshot(native,'me','space');
  assert.deepEqual(projected.items[0].linkedStoryIds,['7064669599']);assert.equal(projected.items[0].nativeCompleted,true);
  assert.equal(projected.items[0].finishedAt,new Date(1795142276713).toISOString());
  present=false;
  const partial=await load();assert.equal(partial.relationCoverage,'partial');assert.equal(partial.facts[0].linkedStoryIds,undefined);
});

test('new-state creator names reuse the existing user batch and project independently of reporter',async()=>{
  const {client,calls}=fake((route,body)=>{
    assert.equal(route,'user/query');assert(body.user_keys.includes('creator'));
    return{data:[{user_key:'creator',name:{zh_cn:'新建人甲'}}]};
  });
  const fact=projectResponsibility(item({created_by:'creator'}),[],client,catalog,space);
  fact.statusName='新建';
  await hydrateFactNames(client,[fact]);
  const snapshot=projectFeishuSnapshot({generatedAt:'now',fetchedAt:1,retrievalComplete:true,classificationComplete:true,relationCoverage:'not_queried',facts:[fact]},'me','space');
  assert.deepEqual(snapshot.items[0].creatorNames,['新建人甲']);
  assert.deepEqual(snapshot.workbenchItems[0].creatorNames,['新建人甲']);
  assert.equal(calls.filter(call=>call.route==='user/query').length,1);
});

test('generic user lookup resolves node and reporter names in one batch, with explicit missing identity',async()=>{
  const {client,calls}=fake((route,body)=>{
    assert.equal(route,'user/query');assert.deepEqual(body.user_keys,['me','reporter']);
    return{data:[{user_key:'me',name:{zh_cn:'张三'}}]};
  });
  const detail=item();detail.fields[1].field_value=[{role:'reporter',owners:['reporter']}];
  const fact=projectResponsibility(detail,[],client,catalog,space);
  await hydrateFactNames(client,[fact]);
  assert.deepEqual(fact.currentNodes[0].ownerNames,['张三']);
  const snapshot=projectFeishuSnapshot({generatedAt:'now',fetchedAt:1,retrievalComplete:true,classificationComplete:true,relationCoverage:'not_queried',facts:[fact]},'me','space');
  assert.deepEqual(snapshot.items[0].fallbackContact,{role:'reporter',names:['姓名未知(reporter)']});
  assert.equal(snapshot.items[0].typeKey,'story');assert.deepEqual(snapshot.items[0].reasons,[]);
  assert.equal(calls.filter(call=>call.route==='user/query').length,1);
});
test('child and defect assignee names share the existing batch without replacing identity keys',async()=>{
  const {client,calls}=fake((route,body)=>{
    assert.equal(route,'user/query');assert.deepEqual(new Set(body.user_keys),new Set(['me','other']));
    return{data:[{user_key:'me',name:{zh_cn:'张三'}},{user_key:'other',name:{zh_cn:'李四'}}]};
  });
  const fact=projectResponsibility(item(),[{work_item_id:'1000000001',node_id:'node',sub_task:{id:'1000000002',name:'子任务',owners:['me','other'],passed:false}}],client,catalog,space);
  fact.responsibleKeys=['other'];
  await hydrateFactNames(client,[fact]);
  assert.deepEqual(fact.mySubtasks[0].owners,['me','other']);assert.deepEqual(fact.mySubtasks[0].ownerNames,['张三','李四']);
  const snapshot=projectFeishuSnapshot({generatedAt:'now',fetchedAt:1,retrievalComplete:true,classificationComplete:true,relationCoverage:'not_queried',facts:[fact]},'me');
  assert.deepEqual(snapshot.items[0].responsibleNames,['李四']);assert.deepEqual(snapshot.workbenchItems[0].mySubtasks[0].ownerNames,['张三','李四']);
  assert.equal(calls.filter(call=>call.route==='user/query').length,1);
});

test('bounded application candidate lookup rejects excessive total on its first page',async()=>{
  const {client,calls}=fake(()=>({data:[],pagination:{total:101,page_num:1}}));
  await assert.rejects(client.candidatesForType('application'),/分页/);
  assert.equal(calls.filter(call=>call.route.endsWith('filter')).length,1);
});

test('project detail accepts the real keyed response and rejects absent or conflicting project identity',async()=>{
  const {client}=fake(()=>({data:{space:{simple_name:'demo',name:'空间'}}}));
  assert.equal((await client.space()).project_key,'space');assert.equal((await client.space()).simple_name,'demo');
  const absent=fake(()=>({data:{other:{simple_name:'wrong'}}})).client;
  await assert.rejects(absent.space(),/缺少对象/);
  const conflict=fake(()=>({data:{space:{project_key:'other'}}})).client;
  await assert.rejects(conflict.space(),/身份不匹配/);
});

test('consumer surfaces controlled Feishu errors and never exposes raw transport exceptions',async()=>{
  const invalid=fake(()=>({data:{}})).client;
  await assert.rejects(new FeishuWorkbenchSource(()=>invalid).loadFresh({scope:config.scope,projectKey:config.projectKey,userKey:config.userKey}),{code:'FEISHU_SOURCE_INVALID',status:502});
  const unavailable=fake(()=>{throw Error('secret-provider-detail');}).client;
  await assert.rejects(new FeishuWorkbenchSource(()=>unavailable).loadFresh({scope:config.scope,projectKey:config.projectKey,userKey:config.userKey}),error=>{
    assert.equal((error as any).code,'FEISHU_SOURCE_UNAVAILABLE');assert.doesNotMatch((error as Error).message,/secret-provider/);return true;
  });
});

test('connection config overlays, empty unconfigured domain, strict keys and private scope without business rules', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-feishu-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'feishu.conf'), local = path.join(root, 'feishu.local.conf');
  assert.equal(loadFeishuConfig(base), null);
  fs.writeFileSync(base, 'CONFIG_VERSION=1\nCONNECTION_ID=\n'); assert.equal(loadFeishuConfig(base), null);
  fs.writeFileSync(local, 'CONNECTION_ID=test\nPROJECT_KEY=space\nUSER_KEY=me\nPLUGIN_ID=plugin\nPLUGIN_SECRET=secret');
  const first = loadFeishuConfig(base)!; assert.equal(first.projectKey,'space');
  assert.equal(Object.hasOwn(first,'responsibilityRoles'),false);
  assert.match(first.scope, /^[a-f0-9]{64}$/); assert.ok(!first.scope.includes('secret'));
  fs.appendFileSync(local, '\nRESPONSIBILITY_ROLES.issue=old_role'); assert.throws(() => loadFeishuConfig(base), /未知配置项/);
  fs.writeFileSync(local, 'CONFIG_VERSION=2'); assert.throws(() => loadFeishuConfig(base), /版本1/);
  fs.writeFileSync(local, 'UNKNOWN=secret'); assert.throws(() => loadFeishuConfig(base), error => !String(error).includes('secret'));
});

test('workbench adapter resolves defect collaborators dynamically without connection role configuration',async()=>{
  let roleId='dynamic_collaborator',roleName='协作人',archived=false;
  const {client}=fake(route=>{
    const defect=item({work_item_type_key:'issue',pattern:'State',work_item_status:{state_key:'active',is_archived_state:archived},
      fields:[{field_key:'owner',field_value:'other'},{field_key:'issue_operator',field_value:'other'},{field_key:'role_owners',field_value:[{role:roleId,owners:['me']}]}]});
    if(route.endsWith('all-types'))return{data:catalog};
    if(route==='projects/detail')return{data:{space}};
    if(route.endsWith('filter'))return{data:[defect],pagination:{total:1}};
    if(route.endsWith('subtask/search'))return{data:[],pagination:{total:0}};
    if(route==='space/flow_roles/issue')return{data:[{id:roleId,name:roleName,is_owner:false}]};
    if(route.endsWith('/workflow/query'))return{data:{state_flow_nodes:[{id:'active',name:'处理中'}]}};
    if(route.endsWith('/meta'))return{data:[]};
    return{data:[defect]};
  });
  const native=await new FeishuResponsibilityService(client).load();
  assert.equal(native.facts[0].actionability,'unverified');
  const source=new FeishuWorkbenchSource(()=>client),identity={scope:config.scope,projectKey:config.projectKey,userKey:config.userKey};
  const first=await source.loadFresh(identity);
  assert.equal(first.items[0].actionability,'state_responsibility');assert.deepEqual(first.items[0].myRoleKeys,[roleId]);
  assert.deepEqual(first.workbenchItems[0].roleOwnerUserKeys,['me']);assert.equal(first.complete,true);
  roleId='changed_id_from_feishu';
  assert.deepEqual((await source.loadFresh(identity)).items[0].myRoleKeys,[roleId]);
  archived=true;
  const history=await source.loadFresh(identity);
  assert.equal(history.items.length,1);assert.equal(history.items[0].nativeCompleted,true);assert.equal(history.counts.stateResponsibility,0);
  archived=false;roleName='知会人';
  const observer=await source.loadFresh(identity);assert.equal(observer.items.length,0);assert.equal(observer.unverifiedCount,1);
  assert.deepEqual(taskRegistryResponsibilityRoles('story',[{id:roleId,name:'协作人',isOwner:true}]),[]);
});

test('one auth and deduplicated requests; partial or cross-space details fail without leaking response values', async () => {
  const { client, calls } = fake(() => ({ data: catalog }));
  await Promise.all([client.catalog(), client.catalog()]);
  assert.equal(calls.length, 2); assert.equal(calls[0].body.plugin_secret, 'secret');
  const bad = fake(() => ({ data: [item({ project_key: 'other' })] })).client;
  await assert.rejects(bad.details('story', ['1000000001']), /身份|空间/);
  await assert.rejects(fake(() => ({ data: [] })).client.details('story', ['1000000001']), /不完整/);
  const failed = fake(() => ({ err_code: 1, err_msg: 'private-token and secret' })).client;
  await assert.rejects(failed.catalog(), error => /response/.test(String(error)) && !/secret|private-token/.test(String(error)));
});

test('flow role definitions use the dedicated GET and validate names, identities and permission flags', async () => {
  const {client,calls}=fake(route=>{
    assert.equal(route,'space/flow_roles/story');
    return {data:[{id:'role_data',name:' 数据负责人 ',is_owner:false,members:['private-member']}]};
  });
  assert.deepEqual(await client.flowRoles('story'),[{id:'role_data',name:'数据负责人',isOwner:false}]);
  assert.deepEqual(calls[1].body,{});
  assert.equal(calls[1].method,'GET');
  for(const data of [[{id:'role_data',name:'',is_owner:true}],[{id:'role_data',name:'研发',is_owner:'true'}],[{id:'role_data',name:'研发',is_owner:true},{id:'role_data',name:'重复',is_owner:true}]]) {
    await assert.rejects(fake(()=>({data})).client.flowRoles('story'),/角色定义/);
  }
});

test('role labels resolve automatically once per type across detail batches and retain closed participation',async()=>{
  const all=Array.from({length:51},(_,index)=>item({id:String(1000000001+index),
    fields:[{field_key:'owner',field_value:'other'},{field_key:'role_owners',field_value:[{role:'role_data',owners:['me']}]}],
    workflow_infos:{workflow_nodes:[{id:'node',status:3,owners:['other']}]}}));
  const {client,calls}=fake((route,body)=>{
    if(route.endsWith('all-types'))return{data:[catalog[0]]};
    if(route==='projects/detail')return{data:{space}};
    if(route.endsWith('subtask/search'))return{data:[],pagination:{total:0}};
    if(route.endsWith('filter'))return{data:all,pagination:{total:all.length}};
    if(route==='space/flow_roles/story')return{data:[{id:'role_data',name:'研发负责人',is_owner:true}]};
    if(route.endsWith('/query'))return{data:all.filter(row=>body.work_item_ids.includes(row.id))};
    throw Error('Unexpected fixture route');
  });
  const result=await new FeishuResponsibilityService(client).load();
  assert.equal(result.facts.length,51);assert.equal(result.classificationComplete,true);
  for(const fact of result.facts){
    assert.deepEqual(fact.reasons,[]);assert.equal(fact.actionability,'noncurrent');
    assert.deepEqual(fact.myRoles,[]);assert.deepEqual(fact.participatingRoleKeys,['role_data']);
  }
  assert.equal(projectFeishuSnapshot(result,'me').items.length,0);
  assert.equal(calls.filter(call=>call.route==='space/flow_roles/story').length,1);
  await new FeishuResponsibilityService(client).load();
  assert.equal(calls.filter(call=>call.route==='space/flow_roles/story').length,2);
  // Unknown roles may first appear in a later detail batch, after an earlier batch needed no lookup.
  for(const row of all.slice(0,50))row.fields[1].field_value[0].owners=['other'];
  const later=await new FeishuResponsibilityService(client).load();
  assert.equal(later.facts.length,1);assert.deepEqual(later.facts[0].reasons,[]);
  assert.equal(calls.filter(call=>call.route==='space/flow_roles/story').length,3);
  assert.equal(calls.at(-1)?.route,'space/flow_roles/story');
});

test('a role name or owner permission flag never creates current responsibility without native evidence',()=>{
  const client=fake(()=>({})).client;
  for(const isOwner of [true,false]){
    const definitions=[{id:'role_data',name:'负责人',isOwner}];
    const fields=[{field_key:'owner',field_value:'other'},{field_key:'role_owners',field_value:[{role:'role_data',owners:['me']}]}];
    for(const [status,expected] of [[1,'upcoming'],[2,'current'],[3,'noncurrent']] as const){
      const fact=projectResponsibility(item({fields,workflow_infos:{workflow_nodes:[{id:'node',status,owners:['me']}]}}),[],client,catalog,space,definitions);
      assert.equal(fact.actionability,expected);assert.deepEqual(fact.reasons,[]);assert.deepEqual(fact.myRoles,[]);
    }
    const ambiguous=projectResponsibility(item({fields,workflow_infos:{workflow_nodes:[{id:'node',status:2,owners:['other']}]}}),[],client,catalog,space,definitions);
    assert.equal(ambiguous.actionability,'unverified');assert.deepEqual(ambiguous.reasons,['unverified_role_responsibility']);
    const state=projectResponsibility(item({pattern:'State',fields}),[],client,catalog,space,definitions);
    assert.equal(state.actionability,'unverified');assert.deepEqual(state.myRoles,[]);
    const missing=projectResponsibility(item({fields,workflow_infos:undefined}),[],client,catalog,space,definitions);
    assert.equal(missing.actionability,'unverified');assert(missing.reasons.includes('unknown_workflow'));
    const wrongTypeDefinition=projectResponsibility(item({fields}),[],client,catalog,space,[{id:'different_role',name:'负责人',isOwner}]);
    assert(wrongTypeDefinition.reasons.includes('unmapped_role'));
  }
});

test('optional role metadata failure preserves native responsibility and its unresolved label diagnostic',async()=>{
  const detail=item();detail.fields[1].field_value=[{role:'role_data',owners:['me']}];
  const all=Array.from({length:51},(_,index)=>({...detail,id:String(1000000001+index)}));
  let failMetadata=true;
  const {client,calls}=fake((route,body)=>{
    if(route==='space/flow_roles/story'){
      if(failMetadata)throw Error('private upstream payload');
      return{data:[{id:'role_data',name:'研发负责人',is_owner:true}]};
    }
    if(route.endsWith('all-types'))return{data:catalog};
    if(route==='projects/detail')return{data:{space}};
    if(route.endsWith('subtask/search'))return{data:[],pagination:{total:0}};
    if(route.endsWith('filter'))return{data:all,pagination:{total:all.length}};
    if(route==='user/query')return{data:[{user_key:'me',name:'本人'}]};
    return{data:all.filter(row=>body.work_item_ids.includes(row.id))};
  });
  const result=await new FeishuResponsibilityService(client).load();
  assert.equal(result.classificationComplete,true);assert.equal(result.facts.length,51);
  for(const fact of result.facts){assert.equal(fact.actionability,'current');assert.deepEqual(fact.reasons,['unmapped_role']);}
  assert.equal(calls.filter(call=>call.route==='space/flow_roles/story').length,1);
  failMetadata=false;
  const recovered=await new FeishuResponsibilityService(client).load();
  assert.equal(calls.filter(call=>call.route==='space/flow_roles/story').length,2);
  for(const fact of recovered.facts)assert.deepEqual(fact.reasons,[]);
});

test('wire contract preserves numeric filter/operation IDs, string detail IDs and GET subtasks',async()=>{
  const requests:Array<{route:string;method:string;body:Row}> = [];
  const client=new FeishuProjectClient(config,(async(url,init)=>{
    const route=String(url).split('/open_api/')[1],body=init?.body?JSON.parse(String(init.body)):{};
    requests.push({route,method:init?.method??'GET',body});
    return new Response(JSON.stringify(route==='authen/plugin_token'?{data:{token:'fake'}}
      :route.endsWith('filter')?{data:[item()],pagination:{total:1}}
      :route.endsWith('/query')?{data:[item()]}
      :route.endsWith('/task')?{data:[]}:{data:{has_more:false,op_records:[]}}));
  }) as typeof fetch,Date.now,0);
  await client.discover(['1000000001'],['story']);
  await client.details('story',['1000000001']);
  await client.subtasks('story','1000000001');
  await client.operations('1000000001',1000,2000);
  assert.deepEqual(requests.find(r=>r.route.endsWith('filter'))?.body.work_item_ids,[1000000001]);
  assert.deepEqual(requests.find(r=>r.route.endsWith('/query'))?.body.work_item_ids,['1000000001']);
  assert.equal(requests.find(r=>r.route.endsWith('/task'))?.method,'GET');
  assert.deepEqual(requests.find(r=>r.route.startsWith('op_record/'))?.body.work_item_ids,[1000000001]);
  const before=requests.length;
  await assert.rejects(client.discover(['9007199254740993'],['story']),/安全整数/);
  assert.equal(requests.length,before);
});

test('pagination completes both candidate routes and rejects drift, duplicates and missing flags', async () => {
  const { client } = fake((route, body) => route.includes('subtask') ? { data: [], pagination: { total: 0 } }
    : { data: Array.from({ length: body.page_num === 1 ? 100 : 1 }, (_, index) => item({ id: String(1000000001 + index + (body.page_num - 1) * 100) })), pagination: { total: 101, page_num: body.page_num } });
  assert.equal((await client.candidates(['story'])).length, 101); assert.equal((await client.subtaskCandidates()).length, 0);
  const duplicate = fake((_route, body) => ({ data: [item()], pagination: { total: 2, page_num: body.page_num } })).client;
  await assert.rejects(duplicate.candidates(['story']), /重复/);
  const drift = fake((_route, body) => ({ data: [item({ id: String(1000000000 + body.page_num) })], pagination: { total: body.page_num === 1 ? 3 : 2 } })).client;
  await assert.rejects(drift.candidates(['story']), /分页不完整/);
  await assert.rejects(fake(() => ({ data: [], pagination: {} })).client.subtaskCandidates(), /分页/);
});

test('responsibility separates creator/roles and respects passed, completed/upcoming/unknown nodes', () => {
  const client = fake(() => ({})).client;
  const defect = item({ work_item_type_key: 'issue', pattern: 'State', fields: [{ field_key: 'owner', field_value: 'me' }, { field_key: 'issue_operator', field_value: 'other' }, { field_key: 'role_owners', field_value: [{ role: 'reporter', owners: ['me'] }] }] });
  assert.equal(projectResponsibility(defect, [], client, catalog, space).actionability, 'noncurrent');
  assert.deepEqual(projectResponsibility(defect, [], client, catalog, space).roleOwners, []);
  defect.fields[2].field_value = [{ role: 'unmapped', owners: ['me'] }];
  assert.equal(projectResponsibility(defect, [], client, catalog, space).actionability, 'unverified');
  const upcoming = item({ workflow_infos: { workflow_nodes: [{ id: 'node', status: 1, owners: ['me'] }] } });
  assert.equal(projectResponsibility(upcoming, [], client, catalog, space).actionability, 'upcoming');
  const completed = item({ workflow_infos: { workflow_nodes: [{ id: 'node', status: 3, owners: ['me'] }] } });
  const child = { work_item_id: '1000000001', node_id: 'node', sub_task: { id: '1000000002', name: '子任务', owners: ['me'], passed: true, finish_time: '2026-11-19T10:00:00+08:00' } };
  const fact = projectResponsibility(completed, [child], client, catalog, space);
  assert.equal(fact.actionability, 'noncurrent'); assert.equal(fact.mySubtasks[0].finishedAt, '2026-11-19T02:00:00.000Z');
  child.sub_task.passed = false; assert.equal(projectResponsibility(completed, [child], client, catalog, space).actionability, 'unverified');
  assert.throws(() => projectResponsibility(completed, [child, child], client, catalog, space), /重复/);
  assert.throws(() => timestamp(1234), /时间/);
  const missingWorkflow=projectResponsibility(item({workflow_infos:undefined}),[],client,catalog,space);
  assert.equal(missingWorkflow.actionability,'unverified');
  assert(missingWorkflow.reasons.includes('unknown_workflow'));
});

test('subtask-only parent uses bounded discovery and batch detail; adapter returns no local associations', async () => {
  const { client, calls } = fake((route, body) => {
    if (route.endsWith('all-types')) return { data: catalog };
    if (route === 'projects/detail') return { data: { [space.project_key]: space } };
    if (route.endsWith('filter')) return { data: body.work_item_ids ? [item()] : [], pagination: { total: body.work_item_ids ? 1 : 0 } };
    if (route.endsWith('subtask/search')) return { data: [{ work_item_id: '1000000001', node_id: 'node', sub_task: { id: '1000000002', owners: ['me'], passed: false } }], pagination: { total: 1 } };
    if (route.endsWith('/query')) return { data: [item()] };
    throw new Error(`Unexpected fixture route ${route}`);
  });
  const result = await new FeishuResponsibilityService(client).load();
  assert.equal(result.facts[0].actionability, 'current'); assert.equal(result.relationCoverage, 'not_queried');
  const snapshot = WorkspaceConsoleResponsibilityDtoSchema.parse(projectFeishuSnapshot(result, 'me'));
  assert.deepEqual(snapshot.items[0].localTaskIds, []); assert.deepEqual(snapshot.localAssociated, []);
  assert.equal(snapshot.items[0].url, 'https://project.feishu.cn/test/requirement/detail/1000000001');
  assert.equal(calls.filter(call => call.route.endsWith('/query') && call.route !== 'user/query').length, 1);
});

test('an unmapped extra role does not block confirmed native node responsibility',async()=>{
  const current=item();current.fields[1].field_value=[{role:'unknown_role',owners:['me']}];
  const {client}=fake(route=>route.endsWith('all-types')?{data:catalog}:route==='projects/detail'?{data:[space]}
    :route.endsWith('subtask/search')?{data:[],pagination:{total:0}}
    :route.endsWith('filter')?{data:[current],pagination:{total:1}}:{data:[current]});
  const result=await new FeishuResponsibilityService(client).load();
  assert.equal(result.facts[0].actionability,'current');assert.equal(result.classificationComplete,true);
  assert.deepEqual(result.facts[0].reasons,['unmapped_role']);
  const snapshot=projectFeishuSnapshot(result,'me');
  assert.equal(snapshot.items.length,1);assert.equal(snapshot.complete,true);assert.equal(snapshot.unverifiedCount,0);
});

test('closed native flow with an extra role is noncurrent; absent evidence and other gaps remain unresolved',()=>{
  const client=fake(()=>({})).client;
  const unknownRole={field_key:'role_owners',field_value:[{role:'unknown_role',owners:['me']}]};
  const ended=projectResponsibility(item({fields:[{field_key:'owner',field_value:'other'},unknownRole],workflow_infos:{workflow_nodes:[{id:'node',status:3,owners:['me']}]}}),[],client,catalog,space);
  assert.equal(ended.actionability,'noncurrent');assert.deepEqual(ended.reasons,['unmapped_role']);assert.equal(hasUnverifiedResponsibility(ended),false);
  const unknown=projectResponsibility(item({fields:[{field_key:'owner',field_value:'other'},unknownRole],workflow_infos:undefined}),[],client,catalog,space);
  assert.equal(unknown.actionability,'unverified');assert.equal(hasUnverifiedResponsibility(unknown),true);
  const missing=projectResponsibility(item({fields:[{field_key:'owner',field_value:'other'}]}),[],client,catalog,space);
  assert.equal(missing.actionability,'current');assert.equal(hasUnverifiedResponsibility(missing),true);
  const ambiguous=projectResponsibility(item({fields:[{field_key:'owner',field_value:'other'},unknownRole],workflow_infos:{workflow_nodes:[{id:'node',status:2,owners:['other']}]}}),[],client,catalog,space);
  assert.equal(ambiguous.actionability,'unverified');assert.equal(hasUnverifiedResponsibility(ambiguous),true);
});

test('closed role-only participation stays in the report as history without blocking classification',async()=>{
  const historical=item({fields:[{field_key:'owner',field_value:'other'},{field_key:'role_owners',field_value:[{role:'unknown_role',owners:['me']}]}],
    workflow_infos:{workflow_nodes:[{id:'node',status:3,owners:['other']}]}});
  const {client}=fake(route=>route.endsWith('all-types')?{data:catalog}:route==='projects/detail'?{data:{space}}:
    route.endsWith('subtask/search')?{data:[],pagination:{total:0}}:route.endsWith('filter')?{data:[historical],pagination:{total:1}}:{data:[historical]});
  const result=await new FeishuResponsibilityService(client).load();
  assert.equal(result.facts.length,1);assert.equal(result.facts[0].myNodes.length,0);assert.equal(result.facts[0].actionability,'noncurrent');
  assert.deepEqual(result.facts[0].reasons,['unmapped_role']);assert.equal(result.classificationComplete,true);
  const projected=projectFeishuSnapshot(result,'me');assert.equal(projected.workbenchItems.length,1);assert.equal(projected.items.length,0);assert.equal(projected.unverifiedCount,0);
});

test('operations preserve cursor and absolute time and reject cross-space records', async () => {
  const page = { has_more: true, start_from: 'next', op_records: [{ work_item_id: '1000000001', project_key: 'space', operation_time: 1500, op_record_module: 'sub_task_mod', operation_type: 'complete', record_contents: [{ object: { object_type: 'sub_task', object_value: '1000000002' } }] }] };
  const client = fake(() => ({ data: page })).client;
  const result = await readOperationPage(client, '1000000001', 1000, 2000);
  assert.equal(result.cursor, 'next'); assert.equal(result.events[0].childId, '1000000002');
  page.op_records[0].project_key = 'other'; await assert.rejects(readOperationPage(client, '1000000001', 1000, 2000), /身份/);
});

test('specified relations paginate within the exact type and do not recursively query a graph', async () => {
  const { client, calls } = fake((_route, body) => ({ data: [item({ id: String(1000000000 + body.page_num), work_item_type_key: 'issue' })], pagination: { page_num: body.page_num, total: 2 } }));
  assert.equal((await client.related('story', '1000000001', 'issue', 'rel_test')).length, 2);
  assert.equal(calls.filter(call => call.route.includes('search_by_relation')).length, 2);
  assert.ok(calls.every(call => call.route === 'authen/plugin_token' || call.body.relation_work_item_type_key === 'issue'));
  await assert.rejects(fake(() => ({ data: [item()], pagination: { total: 1 } })).client.related('story', '1000000001', 'issue', 'rel_test'), /类型/);
});
