import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import React from 'react';

const require=createRequire(import.meta.url);
const bundle=buildSync({entryPoints:[fileURLToPath(new URL('./AnalyticsHelp.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react/jsx-runtime','react-dom']}).outputFiles[0].text;
function harness(t,content='提示内容'){
  const slots=[],effects=[],timers=new Map(),listeners=new Map(),frames=new Map();let cursor=0,active=null,nextId=1;
  const keys=['window','document','setTimeout','clearTimeout','requestAnimationFrame','cancelAnimationFrame'];
  const originals=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  const surface=name=>({addEventListener:(type,fn)=>listeners.set(name+type,fn),removeEventListener:(type,fn)=>{if(listeners.get(name+type)===fn)listeners.delete(name+type);}});
  globalThis.window={...surface('w'),innerWidth:360,innerHeight:700,matchMedia:()=>({matches:true})};globalThis.document={...surface('d'),body:{}};
  globalThis.setTimeout=fn=>{const id=nextId++;timers.set(id,fn);return id;};globalThis.clearTimeout=id=>timers.delete(id);
  globalThis.requestAnimationFrame=fn=>{const id=nextId++;frames.set(id,fn);return id;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
  const overlay={openOverlay:(_,id)=>{active=id;},closeOverlay:(_,id)=>{if(id===active)active=null;},isOverlayOpen:(_,id)=>id===active};
  const hooks={...React,useId:()=> 'test',useContext:()=>overlay,
    useRef:value=>{const i=cursor++;return slots[i]??={current:value};},
    useState:value=>{const i=cursor++;slots[i]??={value};return[slots[i].value,next=>{slots[i].value=next;}];},
    useCallback:(fn,deps)=>{const i=cursor++;if(!slots[i]||deps.some((d,j)=>d!==slots[i].deps[j]))slots[i]={fn,deps};return slots[i].fn;},
    useEffect:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((d,j)=>d!==old.deps[j])){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  };
  const mod={exports:{}};new Function('require','module','exports',bundle)(name=>name==='react'?hooks:name==='react-dom'?{createPortal:child=>child}:require(name),mod,mod.exports);
  const box={focused:false,matches(){return this.focused;},contains(target){return target===this;},getBoundingClientRect:()=>({left:320,top:100,right:348,bottom:128,width:28,height:28})};
  const popup={contains(target){return target===this;},getBoundingClientRect:()=>({width:300,height:90})};
  function render(){cursor=0;const tree=mod.exports.default({label:'测试',content}),[button,tip]=tree.props.children;button.props.ref.current=box;if(tip)tip.props.ref.current=popup;for(const effect of effects.splice(0))effect();return{button,tip};}
  function flush(map){const pending=[...map.values()];map.clear();pending.forEach(fn=>fn());}
  t.after(()=>{slots.forEach(s=>s?.cleanup?.());for(const[key,desc]of originals){if(desc)Object.defineProperty(globalThis,key,desc);else delete globalThis[key];}});
  return{render,box,popup,timers,listeners,active:()=>active,flushTimers:()=>flush(timers),flushFrames:()=>flush(frames),replace:()=>{active='another';}};
}
test('鼠标延迟打开，可移至浮层阅读，离开关闭；浮层受视口约束',t=>{
  const h=harness(t);h.render().button.props.onPointerEnter({pointerType:'mouse'});assert.equal(h.active(),null);h.flushTimers();assert.ok(h.active());
  let view=h.render();h.flushFrames();view=h.render();assert.ok(view.tip.props.style.left>=8);assert.ok(view.tip.props.style.left+300<=352);
  view.button.props.onPointerLeave({pointerType:'mouse'});view.tip.props.onPointerEnter();h.flushTimers();assert.ok(h.active());
  view.tip.props.onPointerLeave({pointerType:'mouse'});h.flushTimers();assert.equal(h.active(),null);
});
test('触摸不靠悬停打开，点击切换，点击外部和滚动关闭',t=>{
  const h=harness(t),click={stopPropagation(){}};let view=h.render();view.button.props.onPointerEnter({pointerType:'touch'});assert.equal(h.timers.size,0);
  view.button.props.onClick(click);view=h.render();assert.equal(view.button.props['aria-expanded'],true);assert.equal(view.button.props['aria-describedby'],view.tip.props.id);
  view.button.props.onPointerLeave({pointerType:'touch'});h.flushTimers();assert.ok(h.active(),'手指离开触点后仍应保持打开');
  view.button.props.onClick(click);assert.equal(h.active(),null);
  h.render().button.props.onClick(click);h.render();h.listeners.get('dpointerdown')({target:{}});assert.equal(h.active(),null);
  h.render().button.props.onClick(click);h.render();h.listeners.get('wscroll')({target:{}});assert.equal(h.active(),null);
});
test('键盘聚焦立即显示，Escape关闭；其他浮层替换后旧提示不再显示',t=>{
  const h=harness(t);h.box.focused=true;h.render().button.props.onFocus({currentTarget:h.box});assert.ok(h.active());h.render();
  h.listeners.get('dkeydown')({key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(h.active(),null);
  h.render().button.props.onFocus({currentTarget:h.box});h.render();h.replace();assert.equal(h.render().tip,false);assert.equal(h.listeners.size,0);
});
test('折叠所属详情及改变视口关闭浮层，其他详情切换不干扰',t=>{
  const h=harness(t),click={stopPropagation(){}};
  h.render().button.props.onClick(click);h.render();
  const toggle=h.listeners.get('dtoggle');
  toggle({target:{tagName:'DETAILS',open:false,contains:()=>false}});assert.ok(h.active());
  toggle({target:{tagName:'DETAILS',open:true,contains:()=>true}});assert.ok(h.active());
  toggle({target:{tagName:'DETAILS',open:false,contains:node=>node===h.box}});assert.equal(h.active(),null);
  h.render().button.props.onClick(click);h.render();h.listeners.get('wresize')();assert.equal(h.active(),null);
  h.render();assert.equal(h.listeners.size,0);
});
test('提示按中文句号和中英文分号换行，保留已有换行且不拆版本号',t=>{
  const h=harness(t,'第一句。 第二句；第三句;版本 0.54.1。\n已有换行。');
  h.render().button.props.onClick({stopPropagation(){}});
  assert.equal(h.render().tip.props.children,'第一句。\n第二句；\n第三句;\n版本 0.54.1。\n已有换行。');
});
