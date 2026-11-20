import assert from 'node:assert/strict';
import test from 'node:test';
import {buildSummaryStatusIndex,summaryStatusOptions,filterLanesBySummary} from './workspace-summary-filter.ts';
import {workbenchTaskLanes} from './workspace-matters.ts';
import {buildTaskCardModel} from './task-card-model.ts';

const local=(id,status)=>({kind:'local',key:`local:${id}`,task:{id,title:id,status,feishuWorkItemIds:[],runIds:[],sessionIds:[]}});
test('filter choices use the same single summary as each card and count matters rather than member states',()=>{
 const entries=[local('wait1','waiting'),local('wait2','waiting'),local('paused','paused'),local('todo','todo'),local('active','doing'),local('done','done'),local('cancelled','cancelled')];
 const lanes=workbenchTaskLanes(entries),index=buildSummaryStatusIndex(entries,null);
 for(const entry of entries)assert.equal(index.get(entry.key),buildTaskCardModel(entry,null).summaryStatus.label);
 const options=summaryStatusOptions(lanes.unstarted,index);
 assert.deepEqual(new Map(options.map(o=>[o.label,o.count])),new Map([['等待中',2],['已暂停',1],['待处理',1]]));
 assert.equal(summaryStatusOptions(lanes.doing,index).length,1);
 const filtered=filterLanesBySummary(lanes,{doing:'',unstarted:'等待中',completed:'已取消'},index);
 assert.deepEqual(filtered.unstarted.map(e=>e.task.id),['wait1','wait2']);assert.deepEqual(filtered.completed.map(e=>e.task.id),['cancelled']);
 assert.deepEqual(filtered.doing,lanes.doing);
 assert.deepEqual(filterLanesBySummary(lanes,{doing:'',unstarted:'旧状态',completed:''},index).unstarted,lanes.unstarted);
 assert.deepEqual(filterLanesBySummary({...lanes,unstarted:[]},{doing:'',unstarted:'等待中',completed:''},index).unstarted,[],'a search with no matches must remain empty');
});

test('a matter with several different child states has one filter choice',()=>{
 const group={kind:'group',key:'matter',unified:true,parent:{workItemId:'1',mySubtasks:[],myNodes:[],currentNodeNames:[]},members:[local('waiting','waiting'),local('paused','paused')]};
 const index=buildSummaryStatusIndex([group],null),options=summaryStatusOptions([group],index);
 assert.equal(options.length,1);assert.equal(options[0].count,1);assert.equal(options[0].label,buildTaskCardModel(group,null).summaryStatus.label);
});
