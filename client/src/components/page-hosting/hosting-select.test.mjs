import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const code=ts.transpileModule(fs.readFileSync(new URL('./HostingSelect.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function nodes(tree,predicate){if(Array.isArray(tree))return tree.flatMap(node=>nodes(node,predicate));if(!tree||typeof tree!=='object')return [];return [...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)];}
function harness(t,top=100){
  let cursor=0;const slots=[],effects=[],listeners=new Map(),changes=[];
  const originals=['window','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  const events={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  globalThis.document=events;globalThis.window={...events,innerHeight:640};
  const trigger={getBoundingClientRect:()=>({top,bottom:top+48}),focus(){changes.push('focus');}};
  const list={scrollTop:0,clientHeight:100,contains:target=>target===list,querySelector:()=>({offsetTop:0,offsetHeight:40})};
  const root={contains:target=>target===trigger||target===list,closest:()=>({getBoundingClientRect:()=>({top:20,bottom:600})})};
  const hooks={
    useId:()=> 'select',
    useRef(value){const i=cursor++;return slots[i]??={current:value};},
    useState(value){const i=cursor++;slots[i]??={value};return [slots[i].value,next=>{slots[i].value=typeof next==='function'?next(slots[i].value):next;}];},
    useEffect:effect,useLayoutEffect:effect,
  };
  function effect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((value,n)=>value!==old.deps[n])){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}}
  const module={exports:{}};new Function('require','module','exports',code)(name=>name==='react'?hooks:jsx,module,module.exports);
  const props={label:'发布到',value:'',options:[{value:'',label:'新增页面'},{value:'disabled',label:'不可用',disabled:true},{value:'site',label:'已有页面',description:'index.html'}],onChange:value=>changes.push(value)};
  const render=()=>{
    cursor=0;const tree=module.exports.default(props);
    for(const node of nodes(tree,node=>node.props?.ref)){node.props.ref.current=node.props.role==='combobox'?trigger:node.props.role==='listbox'?list:root;}
    for(const fn of effects.splice(0))fn();return tree;
  };
  const key=(tree,key)=>{const event={key,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};nodes(tree,node=>node.props?.role==='combobox')[0].props.onKeyDown(event);return event;};
  const toggle=tree=>nodes(tree,node=>node.props?.role==='combobox')[0].props.onClick();
  t.after(()=>{for(const slot of slots)slot?.cleanup?.();for(const [key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return {render,key,toggle,props,changes,listeners,list,trigger};
}
test('keyboard selection skips unavailable targets and restores focus',t=>{
  const h=harness(t);let tree=h.render();h.key(tree,'ArrowDown');tree=h.render();h.key(tree,'ArrowDown');tree=h.render();h.key(tree,'Enter');tree=h.render();
  assert.deepEqual(h.changes,['site','focus']);assert.equal(nodes(tree,node=>node.props?.role==='listbox').length,0);
});
test('Escape closes the choice list without reaching the containing dialog',t=>{
  const h=harness(t);h.toggle(h.render());let tree=h.render();const event=h.key(tree,'Escape');tree=h.render();
  assert.equal(event.stopped,true);assert.equal(event.prevented,true);assert.equal(nodes(tree,node=>node.props?.role==='listbox').length,0);
});
test('clicking inside does not close; outside clicks and outer scrolling close',t=>{
  const h=harness(t);h.toggle(h.render());h.render();h.listeners.get('pointerdown')({target:h.list});
  assert.equal(nodes(h.render(),node=>node.props?.role==='listbox').length,1);
  h.listeners.get('scroll')({target:h.list});assert.equal(nodes(h.render(),node=>node.props?.role==='listbox').length,1);
  h.listeners.get('scroll')({target:{}});assert.equal(nodes(h.render(),node=>node.props?.role==='listbox').length,0);
  h.toggle(h.render());h.render();h.listeners.get('pointerdown')({target:{}});assert.equal(nodes(h.render(),node=>node.props?.role==='listbox').length,0);
});
test('a narrow lower viewport opens upward, and reselecting a target is explicit',t=>{
  const h=harness(t,500);h.toggle(h.render());h.render();let tree=h.render();
  const list=nodes(tree,node=>node.props?.role==='listbox')[0];assert.match(list.props.className,/opens-up/);assert.ok(list.props.style.maxHeight<=240);
  nodes(tree,node=>node.props?.role==='option')[0].props.onClick();assert.equal(h.changes[0],'');
});

test('changing option order closes the old keyboard selection before it can choose another target',t=>{
  const h=harness(t);h.toggle(h.render());let tree=h.render();h.key(tree,'ArrowDown');h.render();
  h.props.options=[h.props.options[2],h.props.options[0]];h.render();tree=h.render();
  assert.equal(nodes(tree,node=>node.props?.role==='listbox').length,0);
  h.key(tree,'Enter');assert.deepEqual(h.changes,[]);
  tree=h.render();assert.equal(nodes(tree,node=>node.props?.role==='option'&&node.props['data-active'])[0].props['aria-selected'],true);
});

test('Home and End open at the first and last available choices',t=>{
  const h=harness(t);let tree=h.render();h.key(tree,'End');tree=h.render();h.key(tree,'Enter');assert.equal(h.changes[0],'site');
  tree=h.render();h.key(tree,'Home');tree=h.render();h.key(tree,'Enter');assert.equal(h.changes[2],'');
});
