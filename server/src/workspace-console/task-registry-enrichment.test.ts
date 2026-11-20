import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichRegistryItems, referenceIds, releaseReferences, resolveRelease } from './task-registry-enrichment.js';
import type { FeishuProjectClient, Row } from '../integrations/feishu/client.js';

test('release selects dated version, preserves canary conflicts and rejects non-reference values', () => {
  const refs = releaseReferences({ fields: [{field_key:'normal',field_value:['10']},{field_key:'canary',field_value:['11','12']},{field_key:'flag',field_value:{label:'否'}}] }, 'normal', 'canary', 'flag');
  const value = resolveRelease(refs, new Map([['11','2027-02-03'],['12','2026-12-01']]));
  assert.equal(value.versionId,'12'); assert.equal(value.mode,'canary'); assert.equal(value.conflict,true);
  assert.throws(()=>releaseReferences({fields:[{field_key:'normal',field_value:true}]},'normal','',''));
  assert.deepEqual(referenceIds('  '),[]);assert.deepEqual(referenceIds('1， 2 3'),['1','2','3']);
});

test('issues inherit matching stories and native/explicit applications remain separate projections', async () => {
  const row = (id:string,type:string,fields:Row[],nodes:Row[]=[])=>({id,name:id,project_key:'space',work_item_type_key:type,fields,workflow_infos:{workflow_nodes:nodes}});
  const field=(field_key:string,field_value:unknown)=>({field_key,field_value});
  const issue=row('1','issue',[field('stories',['2'])]);
  const story=row('2','story',[field('canary',['3'])],[{id:'node',name:'金丝雀发布',status:2}]);
  const app=row('4','application',[field('stories',['2']),field('finish_status',true)],[{id:'appnode',name:'结束',status:3}]);
  const calls:string[]=[];
  const client={metadata:async()=>['normal','canary','flag','stories'].map(field_key=>({field_key})),
    details:async(type:string,ids:string[])=>{calls.push(type+':'+ids.join(','));return ids.map(id=>type==='story'?story:type==='version'?{id,name:'2026-12-01'}:app);},
    candidatesForType:async()=>[app],subtasks:async()=>[{sub_tasks:[]}],
  } as unknown as FeishuProjectClient;
  const options={ADAPTER_VERSION_FIELD:'normal',ADAPTER_CANARY_VERSION_FIELD:'canary',ADAPTER_CANARY_FLAG_FIELD:'flag',ADAPTER_STORY_RELATION_FIELD:'stories',ADAPTER_APPLICATION_TYPE:'application',ADAPTER_APPLICATION_STORY_FIELD:'stories',ADAPTER_RELEASE_NODE_NAME:'金丝雀发布'};
  const registry={schemaVersion:1,generatedAt:null,tasks:[]};
  const result=await enrichRegistryItems(client,options,new Map([['1',issue]]),registry);
  assert.equal(result.partial,false);assert.equal(result.contexts.get('1')?.release?.source,'linked_story');
  assert.equal(result.contexts.get('1')?.release?.versionId,'3');
  assert.equal(result.contexts.get('2')?.applications?.[0].reconciliationRequired,true);
  assert.equal(result.contexts.get('1')?.applications?.[0].workItemId,'4');
  assert.deepEqual(calls,['story:2','version:3','application:4']);
});

test('bounded application failures preserve release facts and mark coverage partial',async()=>{
  const details=new Map([['1',{id:'1',work_item_type_key:'story',fields:[{field_key:'canary',field_value:['2']}],workflow_infos:{workflow_nodes:[{name:'发布',status:2}]}}]]);
  const client={metadata:async()=>[{field_key:'canary'},{field_key:'stories'}],details:async()=>[{id:'2',name:'版本'}],candidatesForType:async()=>{throw Error('over budget');}} as unknown as FeishuProjectClient;
  const result=await enrichRegistryItems(client,{ADAPTER_CANARY_VERSION_FIELD:'canary',ADAPTER_APPLICATION_TYPE:'app',ADAPTER_APPLICATION_STORY_FIELD:'stories',ADAPTER_RELEASE_NODE_NAME:'发布'},details,{schemaVersion:1,generatedAt:null,tasks:[]});
  assert.equal(result.partial,true);assert.equal(result.contexts.get('1')?.release?.version,'版本');assert.equal(result.contexts.get('1')?.applicationCoverage,'partial');
});

test('optional fields are type-specific and native planning_version resolves without metadata',async()=>{
  const client={metadata:async(type:string)=>type==='story'?[{field_key:'canary',field_name:'金丝雀版本'},{field_key:'flag',field_name:'发布标志'}]:[{field_key:'stories',field_name:'关联需求'}],
    details:async(type:string,ids:string[])=>ids.map(id=>({id,name:'2026-12-01'})),
  } as unknown as FeishuProjectClient;
  const details=new Map([['1',{id:'1',work_item_type_key:'story',fields:[{field_key:'planning_version',field_value:['3',null,'']}] }],['2',{id:'2',work_item_type_key:'issue',fields:[]}]]);
  const value=await enrichRegistryItems(client,{ADAPTER_VERSION_FIELD:'规划版本',ADAPTER_CANARY_VERSION_FIELD:'金丝雀版本',ADAPTER_CANARY_FLAG_FIELD:'发布标志',ADAPTER_STORY_RELATION_FIELD:'关联需求'},details,{schemaVersion:1,generatedAt:null,tasks:[]});
  assert.equal(value.partial,true);assert.equal(value.contexts.get('1')?.release?.versionId,'3');assert.equal(value.contexts.get('2')?.release,undefined);
  assert.equal(value.contexts.get('2')?.linkedStoryIds,undefined,'an omitted native relation field is unknown, not an empty relation');
});

test('a selector missing from all metadata remains an explicit configuration gap',async()=>{
  const client={metadata:async()=>[]} as unknown as FeishuProjectClient;
  const value=await enrichRegistryItems(client,{ADAPTER_VERSION_FIELD:'misspelled'},new Map([['1',{id:'1',work_item_type_key:'story',fields:[]}]]),{schemaVersion:1,generatedAt:null,tasks:[]});
  assert.equal(value.partial,true);
});

test('missing and invalid issue relation fields never override verified native links with an empty relation',async()=>{
  const client={metadata:async()=>[{field_key:'stories'}]} as unknown as FeishuProjectClient;
  const details=new Map([['1',{id:'1',work_item_type_key:'issue',fields:[]}],['2',{id:'2',work_item_type_key:'issue',fields:[{field_key:'stories',field_value:[{id:'3'}]}]}]]);
  const value=await enrichRegistryItems(client,{ADAPTER_STORY_RELATION_FIELD:'stories'},details,{schemaVersion:1,generatedAt:null,tasks:[]});
  assert.equal(value.partial,true);
  assert.equal(value.contexts.get('1')?.linkedStoryIds,undefined);assert.equal(value.contexts.get('2')?.linkedStoryIds,undefined);
});

test('unqueried applications inherited from a story are not reported as failed',async()=>{
  const client={metadata:async()=>[{field_key:'stories'}]} as unknown as FeishuProjectClient;
  const value=await enrichRegistryItems(client,{ADAPTER_STORY_RELATION_FIELD:'stories',ADAPTER_APPLICATION_TYPE:'app'},new Map([
    ['1',{id:'1',work_item_type_key:'issue',fields:[{field_key:'stories',field_value:['2']}]}],['2',{id:'2',work_item_type_key:'story',fields:[]}],
  ]),{schemaVersion:1,generatedAt:null,tasks:[]});
  assert.equal(value.partial,false);assert.equal(value.contexts.get('1')?.applicationCoverage,'not_queried');
});
