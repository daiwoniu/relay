import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const code=ts.transpileModule(fs.readFileSync(new URL('./ContextMenu.tsx',import.meta.url),'utf8'),{
  compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;

function harness(t,mobile){
  let cursor=0;const slots=[],effects=[],listeners=new Map(),calls=[];
  const globals=['window','document','HTMLElement','requestAnimationFrame','cancelAnimationFrame'];
  const originals=globals.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  class Element {isConnected=true;contains(target){return target===this;}focus(){}}
  const menu=new Element();
  const eventSource={addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);}};
  Object.assign(globalThis,{HTMLElement:Element,window:{...eventSource,innerWidth:900,innerHeight:700},
    document:{...eventSource,activeElement:new Element(),body:new Element()},
    requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{},
  });
  const hooks={
    useId:()=> 'menu',
    useRef(value){const i=cursor++;return slots[i]??={current:value};},
    useState(value){const i=cursor++;slots[i]??={value};return [slots[i].value,next=>{slots[i].value=next;}];},
    useCallback(fn,deps){const i=cursor++;if(!slots[i]||deps.some((d,n)=>d!==slots[i].deps[n]))slots[i]={deps,fn};return slots[i].fn;},
    useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((d,n)=>d!==old.deps[n])){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  };
  const overlay={openOverlay:()=>calls.push('open'),closeOverlay:()=>calls.push('close'),
    registerOverlayCloser:(_kind,_id,fn)=>{calls.push('register');overlay.requestClose=fn;return()=>calls.push('unregister');}};
  const module={exports:{}};
  new Function('require','module','exports',code)(name=>{
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return jsx;
    if(name==='react-dom')return {createPortal:tree=>tree};
    if(name==='./OverlayProvider')return {useOverlay:()=>overlay};
    if(name==='./focus-restoration')return {shouldRestoreOverlayFocus:()=>false};
    if(name==='./popover-scroll')return {shouldClosePopoverForScroll:(node,target)=>!node.contains(target)};
    if(name==='./popover-resize')return {shouldClosePopoverForWindowResize:()=>!mobile};
    return {};
  },module,module.exports);
  const findMenu=tree=>tree?.props?.role==='menu'?tree:[tree?.props?.children].flat(Infinity).map(child=>child&&typeof child==='object'?findMenu(child):null).find(Boolean);
  const anchorRect={top:10,left:10,right:38,bottom:38,width:28,height:28};
  const render=onClose=>{
    cursor=0;
    const tree=module.exports.default({open:true,anchorRect,onClose,mobile,items:[{id:'action',label:'操作',onSelect:()=>calls.push('action')}]});
    const surface=findMenu(tree);surface.props.ref.current=menu;
    for(const effect of effects.splice(0))effect();
    return {tree,surface};
  };
  t.after(()=>{
    for(const slot of slots)slot?.cleanup?.();
    for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  });
  return {render,calls,listeners,overlay,menu};
}

for(const mobile of [false,true]){
  test(`${mobile?'mobile':'desktop'} menu survives a parent rerender and uses the latest close callback`,t=>{
    const h=harness(t,mobile);
    h.render(()=>h.calls.push('old-callback'));
    const {surface}=h.render(()=>h.calls.push('new-callback'));
    assert.deepEqual(h.calls,['open','register']);
    assert.equal(surface.props['data-overlay-root'],true);
    h.listeners.get('mousedown')({target:h.menu});
    assert.deepEqual(h.calls,['open','register']);
    h.overlay.requestClose();
    assert.equal(h.calls.at(-1),'new-callback');
    assert.equal(h.calls.includes('old-callback'),false);
  });
  test(`${mobile?'mobile':'desktop'} menu action closes once and still executes`,t=>{
    const h=harness(t,mobile);
    const {tree,surface}=h.render(()=>h.calls.push('dismiss'));
    if(mobile)assert.equal(tree.props['data-overlay-root'],true);
    surface.props.children[0].props.onClick();
    assert.deepEqual(h.calls.slice(-2),['dismiss','action']);
  });
}
