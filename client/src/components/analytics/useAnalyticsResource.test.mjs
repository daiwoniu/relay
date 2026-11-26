import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.transpileModule(fs.readFileSync(new URL('./useAnalyticsResource.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
// Run the actual hook with controlled React scheduling and network completions.
function harness(){
  let cursor=0,dirty=true,view,args=['/summary?excludeAdmin=false','admin',0];
  const slots=[],effects=[],requests=[];
  const react={
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=initial;return[slots[index],next=>{const value=typeof next==='function'?next(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true;}}];},
    useRef(initial){const index=cursor++;return slots[index]??={current:initial};},
    useEffect(effect,deps){const index=cursor++,old=slots[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i]))){old?.cleanup?.();slots[index]={deps};effects.push(()=>{slots[index].cleanup=effect();});}},
  };
  const exports={};
  vm.runInNewContext(source,{exports,AbortController,require(name){if(name==='react')return react;if(name==='../../api/client')return{requestJson:(path,options)=>new Promise((resolve,reject)=>requests.push({path,...options,resolve,reject}))};throw Error(name);}});
  function render(){while(dirty){dirty=false;cursor=0;view=exports.useAnalyticsResource(...args);while(effects.length)effects.shift()();}}
  render();
  return{requests,get view(){return view;},retry(){view.retry();render();},change(path,account=args[1],refresh=args[2]){args=[path,account,refresh];dirty=true;render();},async settle(){await new Promise(resolve=>setImmediate(resolve));render();},close(){for(const slot of slots)slot?.cleanup?.();}};
}

test('模块重试保留路径与旧数据，使用实际快照时间并请求受限刷新',async t=>{
 const h=harness();t.after(()=>h.close());h.requests[0].resolve({data:{pv:7},asOf:123456,cached:true});await h.settle();
 assert.equal(h.view.updatedAt,123456);assert.equal(h.view.cached,true);assert.match(h.requests[0].path,/meta=true/);
 h.retry();assert.equal(h.view.data.pv,7);assert.equal(h.view.loading,true);assert.match(h.requests[1].path,/fresh=true/);assert.equal(h.view.dataPath,'/summary?excludeAdmin=false');
 h.requests[1].reject(Error('temporary'));await h.settle();assert.equal(h.view.data.pv,7);assert.equal(h.view.updatedAt,123456);
 h.retry();h.requests[2].resolve({data:{pv:9},asOf:123999,cached:false});await h.settle();assert.equal(h.view.data.pv,9);assert.equal(h.view.error,null);assert.equal(h.view.updatedAt,123999);
 h.change('/summary?excludeAdmin=true');assert.doesNotMatch(h.requests[3].path,/fresh=true/);
 h.change('/summary?excludeAdmin=true','admin',1);assert.match(h.requests[4].path,/fresh=true/);
 h.change('/summary?excludeAdmin=false');assert.doesNotMatch(h.requests[5].path,/fresh=true/);
});

test('筛选请求期间保留同账号结果和时间，并明确标记上次查询而非清空整页',async t=>{
  const h=harness();t.after(()=>h.close());assert.equal(h.view.data,null);
  const first={pv:10};h.requests[0].resolve(first);await h.settle();const updatedAt=h.view.updatedAt;
  h.change('/summary?excludeAdmin=true');
  assert.equal(h.view.data,first);assert.equal(h.view.loading,true);assert.equal(h.view.stale,true);assert.equal(h.view.dataPath,'/summary?excludeAdmin=false');assert.equal(h.view.updatedAt,updatedAt);
  const next={pv:2};h.requests[1].resolve(next);await h.settle();
  assert.equal(h.view.data,next);assert.equal(h.view.loading,false);assert.equal(h.view.stale,false);assert.equal(h.view.dataPath,'/summary?excludeAdmin=true');
});

test('快速切换筛选丢弃迟到响应，换账号立即隐藏旧数据',async t=>{
  const h=harness();t.after(()=>h.close());const first={pv:10};h.requests[0].resolve(first);await h.settle();
  h.change('/summary?excludeAdmin=true');const abandoned=h.requests[1];h.change('/summary?range=today');assert.equal(abandoned.signal.aborted,true);
  abandoned.resolve({pv:999});await h.settle();assert.equal(h.view.data,first);assert.equal(h.view.loading,true);
  h.requests[2].resolve({pv:3});await h.settle();assert.equal(h.view.data.pv,3);
  h.change('/summary?range=today','other-admin');assert.equal(h.view.data,null);assert.equal(h.view.updatedAt,null);assert.equal(h.view.stale,false);
  h.requests[3].resolve({pv:4});await h.settle();assert.equal(h.view.data.pv,4);
});

test('新筛选失败仍保留旧结果及过期标记，重试成功才解除',async t=>{
  const h=harness();t.after(()=>h.close());const first={pv:10};h.requests[0].resolve(first);await h.settle();
  h.change('/summary?excludeAdmin=true');const failure=Error('offline');h.requests[1].reject(failure);await h.settle();
  assert.equal(h.view.data,first);assert.equal(h.view.stale,true);assert.equal(h.view.error,failure);assert.equal(h.view.loading,false);
  h.change('/summary?excludeAdmin=true','admin',1);assert.equal(h.view.error,null);assert.equal(h.view.stale,true);
  h.requests[2].resolve({pv:2});await h.settle();assert.equal(h.view.stale,false);
});

test('撤销访问路径立即隐藏旧结果并取消请求，卸载后返回不能恢复数据',async t=>{
  const h=harness();t.after(()=>h.close());h.requests[0].resolve({pv:10});await h.settle();h.change('/summary?excludeAdmin=true');const pending=h.requests[1];
  h.change(null);assert.equal(h.view.data,null);assert.equal(h.view.loading,false);assert.equal(pending.signal.aborted,true);
  pending.resolve({pv:99});await h.settle();assert.equal(h.view.data,null);
});
