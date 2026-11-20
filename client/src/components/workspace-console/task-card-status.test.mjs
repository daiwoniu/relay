import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeTaskCardStatus} from './task-card-status.ts';

const ledger=(status,id='local')=>({task:{id,title:id,status,feishuWorkItemIds:[]},status,ledgers:[]});
const child=(id,status='当前待处理',kind='subtask')=>({id,title:id,label:'子项',status,completed:false,current:true,target:kind==='subtask'?{kind,subtask:{id}}:{kind,item:{actionability:'state_responsibility'}}});
const base={ledgers:[],relations:[],sources:[],parentCurrent:false,parentExplicit:false,parentEnded:false,hasFeishu:false,completed:false,uncertain:false,stale:false,nodeLines:[]};
const summary=(extra)=>summarizeTaskCardStatus({...base,...extra});
test('only explicit running ledgers are processing; waiting and pauses never inherit the list lane',()=>{
 for(const [state,label] of [['doing','处理中'],['active','处理中'],['in_progress','处理中'],['waiting','等待中'],['paused','已暂停'],['review_pending','待确认'],['todo','待处理'],['blocked','受阻'],['failed','失败'],[null,'待核实']]){
  assert.equal(summary({ledgers:[ledger(state)]}).label,label,state);
 }
});
test('all current defects awaiting acceptance summarize the stage without claiming who accepts',()=>{
 const rows=[child('one','已修复，待验收','project'),child('two','已修复，待验收','project')];
 const model=summary({ledgers:[ledger('waiting')],relations:rows});
 assert.equal(model.label,'待验收');assert.match(model.description,/不据此推断验收操作者是你/);
 assert.equal(summary({relations:[...rows].reverse(),ledgers:[ledger('waiting')]}).label,model.label);
 assert.equal(summary({relations:[...rows,child('new','新建','project')],ledgers:[ledger('waiting')]}).label,'待处理');
 assert.equal(summary({relations:rows,parentCurrent:true,parentExplicit:true,ledgers:[ledger('done')]}).label,'待确认','a separate current parent duty prevents declaring acceptance-only');
});
test('waiting ledger covers its own current child but does not hide another new responsibility',()=>{
 const local=ledger('waiting');local.task.feishuWorkItemIds=['one'];
 assert.equal(summary({ledgers:[local],relations:[child('one')]}).label,'等待中');
 assert.equal(summary({ledgers:[local],relations:[child('one'),child('two')]}).label,'待处理');
});
test('completed delivery with a current parent requires confirmation instead of automatic reopening',()=>{
 const model=summary({ledgers:[ledger('done')],parentCurrent:true,parentExplicit:true,hasFeishu:true});
 assert.equal(model.label,'待确认');assert.match(model.description,/不自动重开台账/);
 assert.equal(summary({parentCurrent:true,parentExplicit:true,hasFeishu:true}).label,'待处理');
 assert.equal(summary({parentCurrent:true,hasFeishu:true}).label,'待确认','a state responsibility alone is insufficient');
});
test('verified personal handoff is complete while the native acceptance state remains visible in the tooltip',()=>{
 const result=summary({personalCompleted:true,completed:true,parentCurrent:true,hasFeishu:true,ledgers:[ledger('done')],sources:[{source:'飞书',label:'已修复，待验收',tone:'waiting'}]});
 assert.equal(result.label,'本轮已完成');assert.match(result.description,/飞书仍待验收/);
 assert.match(result.description,/飞书父项：已修复，待验收/);
});
test('termination distinguishes current delivery, whole workflow and cancellation',()=>{
 assert.equal(summary({completed:true,ledgers:[ledger('done')],hasFeishu:true}).label,'本轮已完成');
 assert.equal(summary({completed:true,ledgers:[ledger('done')],hasFeishu:true,parentEnded:true}).label,'已结束');
 assert.equal(summary({completed:true,ledgers:[ledger('cancelled')]}).label,'已取消');
 assert.equal(summary({completed:true,ledgers:[ledger('done')],uncertain:true}).label,'待核实');
 assert.equal(summary({completed:true,stale:true}).label,'待核实');
 assert.equal(summary({ledgers:[ledger('doing')],stale:true}).label,'处理中','known local execution remains visible');
});
test('mixed work is order-independent, incomplete work wins, and tooltip includes reasons with bounded examples',()=>{
 const rows=[ledger('done','old'),ledger('waiting','waiting'),ledger('doing','working')];
 const model=summary({ledgers:rows});assert.equal(model.label,'处理中');
 assert.equal(summary({ledgers:[...rows].reverse()}).label,model.label);
 assert.match(model.description,/明确登记/);assert.match(model.description,/本地「waiting」/);
 const many=summary({ledgers:Array.from({length:8},(_,i)=>ledger('done',String(i))),completed:true});
 assert.match(many.description,/另有 5 项/);
});
