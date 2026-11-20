import assert from 'node:assert/strict';
import test from 'node:test';
import {activateDetailDialog} from './workspace-detail-dialog.ts';

function fixture(){
 const listeners=new Map(),doc={activeElement:null,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{assert.equal(listeners.get(name),fn);listeners.delete(name);}};
 const button=(visible=true)=>({isConnected:true,focus(){doc.activeElement=this;},getClientRects:()=>visible?[{}]:[]});
 const trigger=button(),first=button(),hidden=button(false),last=button();doc.activeElement=trigger;
 const panel={ownerDocument:doc,querySelector:selector=>{assert.equal(selector,'button:not(:disabled)');return first;},querySelectorAll:()=>[first,hidden,last],contains:element=>[first,last].includes(element)};
 const body={scrollTop:0},positions=new Map([['task',120]]);let closed=0;
 const dispose=activateDetailDialog(panel,body,'task',positions,()=>closed++);
 const key=(key,shiftKey=false,defaultPrevented=false)=>{let prevented=false;listeners.get('keydown')({key,shiftKey,defaultPrevented,preventDefault(){prevented=true;},stopPropagation(){}});return prevented;};
 return {doc,trigger,first,last,body,positions,listeners,dispose,key,closed:()=>closed};
}
test('drawer restores and saves scroll and returns focus on close',()=>{
 const f=fixture();assert.equal(f.doc.activeElement,f.first);assert.equal(f.body.scrollTop,120);
 f.body.scrollTop=320;f.dispose();assert.equal(f.positions.get('task'),320);assert.equal(f.doc.activeElement,f.trigger);assert.equal(f.listeners.size,0);
});
test('Tab stays inside the drawer, excludes hidden actions, and Escape closes it',()=>{
 const f=fixture();assert.equal(f.key('Tab',true),true);assert.equal(f.doc.activeElement,f.last);
 assert.equal(f.key('Tab'),true);assert.equal(f.doc.activeElement,f.first);
 f.doc.activeElement=f.trigger;assert.equal(f.key('Tab'),true);assert.equal(f.doc.activeElement,f.first);
 assert.equal(f.key('Escape',false,true),false);assert.equal(f.closed(),0);
 assert.equal(f.key('Escape'),true);assert.equal(f.closed(),1);f.dispose();
});
test('suspending for file preview saves position without taking focus away from preview',()=>{
 const f=fixture();f.doc.activeElement=f.last;f.dispose(false);assert.equal(f.doc.activeElement,f.last);assert.equal(f.listeners.size,0);
});
