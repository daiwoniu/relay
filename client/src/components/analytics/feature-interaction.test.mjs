import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import React from 'react';
const require=createRequire(import.meta.url);
const bundle=buildSync({entryPoints:[fileURLToPath(new URL('./FeatureAnalytics.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react/jsx-runtime','react-dom']}).outputFiles[0].text;
function harness(t,data){
 let cursor=0,dirty=true,tree,query='range=7d&excludeAdmin=false';const slots=[],effects=[],requests=[];
 const hooks={...React,
  useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;dirty=true;}];},
  useRef(initial){const index=cursor++;return slots[index]??={current:initial};},
  useEffect(fn,deps){const index=cursor++,old=slots[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i]))){old?.cleanup?.();slots[index]={deps};effects.push(()=>slots[index].cleanup=fn());}},
 };
 t.mock.method(globalThis,'fetch',(path,options)=>new Promise((resolve,reject)=>requests.push({path,options,resolve,reject})));
 const mod={exports:{}};new Function('require','module','exports','requestAnimationFrame',bundle)(name=>name==='react'?hooks:require(name),mod,mod.exports,fn=>{fn();return 1;});
 const features={data:data??{features:[{feature:'settings',views:2,actions:3,results:{error:1}}],operations:[{registrationId:'settings.save',feature:'settings',action:'save',count:3}]},loading:false,error:null,stale:false,updatedAt:1,retry:()=>{}};
 function render(){while(dirty){dirty=false;cursor=0;tree=mod.exports.default({query,account:'admin',refresh:0,features});while(effects.length)effects.shift()();}}
 function find(predicate,node=tree){if(!node||typeof node!=='object')return; if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const value=find(predicate,child);if(value)return value;}}
 render();t.after(()=>{for(const slot of slots)slot?.cleanup?.();});
 return{requests,render,find,query(next){query=next;dirty=true;render();},async settle(){await new Promise(resolve=>setImmediate(resolve));render();}};
}
test('点击排行查询对应动作，翻页与切换日期保持筛选并重置游标，模块失败可原地重试',async t=>{
 const h=harness(t);assert.equal(h.requests.length,0,'未展开时不读取明细');
 const ranking=h.find(node=>node.type==='ol'&&node.props.className==='analytics-operation-ranking');
 const button=h.find(node=>node.type==='button',ranking);button.props.onClick();h.render();
 const first=new URL(h.requests[0].path,'http://local');assert.equal(first.searchParams.get('feature'),'settings');assert.equal(first.searchParams.get('action'),'save');assert.equal(first.searchParams.get('metric'),'action');
 h.requests[0].resolve(Response.json({data:{items:[],next:{at:100,id:'00000000-0000-4000-8000-000000000001'}},asOf:123,cached:false}));await h.settle();
 const next=h.find(node=>node.type==='button'&&node.props.children==='下一页');assert.equal(next.props.disabled,false);next.props.onClick();h.render();assert.match(h.requests[1].path,/beforeAt=100/);
 h.query('range=today&excludeAdmin=true');const changed=h.requests[2];assert.doesNotMatch(changed.path,/beforeAt/);assert.match(changed.path,/feature=settings/);assert.match(changed.path,/range=today/);
 changed.reject(Error('temporary'));await h.settle();
 const state=h.find(node=>typeof node.type==='function'&&node.props.label==='操作明细');state.props.resource.retry();h.render();assert.match(h.requests[3].path,/feature=settings/);assert.match(h.requests[3].path,/fresh=true/);
});

test('长列表默认收起，桌面和手机同步展开，不触发明细读取',t=>{
 const h=harness(t,{features:Array.from({length:9},(_,i)=>({feature:`feature-${i}`,views:i,actions:i,results:{}})),operations:Array.from({length:12},(_,i)=>({registrationId:`settings.action-${i}`,feature:'settings',action:`action-${i}`,count:12-i}))});
 const count=className=>React.Children.toArray(h.find(node=>node.props.className===className).props.children).length;
 assert.equal(count('analytics-feature-cards'),6);assert.equal(count('analytics-operation-ranking'),5);
 const toggle=()=>h.find(node=>node.type==='button'&&node.props.className==='analytics-list-toggle');
 assert.equal(toggle().props['aria-expanded'],false);toggle().props.onClick();h.render();
 assert.equal(count('analytics-feature-cards'),9);
 const table=h.find(node=>node.props.className==='analytics-data-table analytics-feature-table');
 assert.equal(React.Children.toArray(h.find(node=>node.type==='tbody',table).props.children).length,9);
 const rankToggle=h.find(node=>node.type==='button'&&node.props.children==='显示全部 12 项排行');rankToggle.props.onClick();h.render();
 assert.equal(count('analytics-operation-ranking'),12);assert.equal(h.requests.length,0);
 toggle().props.onClick();h.render();assert.equal(count('analytics-feature-cards'),6);
});

test('关联查看限定一次操作，说明单条结果并可恢复原筛选',async t=>{
 const h=harness(t);
 const rank=h.find(node=>node.props.className==='analytics-operation-ranking');
 h.find(node=>node.type==='button',rank).props.onClick();h.render();
 const row={id:'a',at:1000,registrationId:'settings.save',feature:'settings',action:'save',metric:'action',result:null,automatic:false,durationMs:null,operationId:'00000000-0000-4000-8000-000000000001'};
 h.requests[0].resolve(Response.json({data:{items:[row],next:null},asOf:123,cached:false}));await h.settle();
 const resultCell=h.find(node=>typeof node.type==='function'&&node.type.name==='RowResult');
 assert.equal(resultCell.type(resultCell.props).props.children,'仅记录操作');
 h.find(node=>node.type==='button'&&node.props.children==='只看这次操作').props.onClick();h.render();
 const related=new URL(h.requests[1].path,'http://local').searchParams;
 assert.equal(related.get('operationId'),row.operationId);assert.equal(related.get('includeSystem'),'true');assert.equal(related.has('action'),false);assert.equal(related.get('range'),'7d');
 h.requests[1].resolve(Response.json({data:{items:[row],next:null},asOf:124,cached:false}));await h.settle();
 const notice=h.find(node=>node.props.className==='analytics-filter-notice');
 const text=JSON.stringify(notice.props.children);assert.match(text,/当前范围：1 条/);assert.match(text,/未找到其他关联记录/);
 assert.equal(h.find(node=>node.type==='button'&&node.props.children==='只看这次操作'),undefined);
 h.find(node=>node.type==='button'&&node.props.children==='返回原筛选').props.onClick();h.render();
 const restored=new URL(h.requests[2].path,'http://local').searchParams;assert.equal(restored.get('action'),'save');assert.equal(restored.get('feature'),'settings');assert.equal(restored.has('operationId'),false);
});

test('仅访问记录不与结果筛选形成无意义组合',t=>{
 const h=harness(t);
 const rank=h.find(node=>node.props.className==='analytics-operation-ranking');
 h.find(node=>node.type==='button',rank).props.onClick();h.render();
 const selectFor=value=>h.find(node=>node.type==='select'&&React.Children.toArray(node.props.children).some(option=>option.props?.value===value));
 selectFor('error').props.onChange({target:{value:'error'}});h.render();
 selectFor('view').props.onChange({target:{value:'view'}});h.render();
 let query=new URL(h.requests[h.requests.length-1].path,'http://local').searchParams;
 assert.equal(query.get('metric'),'view');assert.equal(query.has('result'),false);
 selectFor('error').props.onChange({target:{value:'error'}});h.render();
 query=new URL(h.requests[h.requests.length-1].path,'http://local').searchParams;
 assert.equal(query.get('result'),'error');assert.equal(query.has('metric'),false);
});
