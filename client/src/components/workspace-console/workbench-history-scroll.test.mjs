import assert from 'node:assert/strict';
import test from 'node:test';
import { observeHistoryPageEnd } from './workbench-history-scroll.ts';

function harness() {
  let instance;
  class Observer {
    disconnected = 0;
    constructor(callback, options) { this.callback = callback; this.options = options; instance = this; }
    observe(end) { this.end = end; }
    disconnect() { this.disconnected += 1; }
    emit(isIntersecting, intersectionRatio = 1) { this.callback([{isIntersecting, intersectionRatio}]); }
  }
  const root={removeEventListener() {}}, end={};
  let visible=10;
  let loading=false;
  const cleanup=observeHistoryPageEnd(root,end,()=>{visible+=10;},Observer,(value)=>{loading=value;});
  return {root,end,cleanup,get observer(){return instance;},get visible(){return visible;},get loading(){return loading;}};
}

test('completed list waits for the bottom, shows loading for 500ms and appends only one page', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness();
  assert.equal(h.observer.options.root,h.root);
  assert.equal(h.observer.options.rootMargin,'0px');
  assert.equal(h.observer.options.threshold,1);
  assert.equal(h.observer.end,h.end);
  h.observer.emit(false);
  h.observer.emit(true,0.5);
  assert.equal(h.loading,false);
  assert.equal(h.visible,10);
  h.observer.emit(true);
  h.observer.emit(true);
  assert.equal(h.loading,true);
  t.mock.timers.tick(499);
  assert.equal(h.visible,10);
  t.mock.timers.tick(1);
  assert.equal(h.visible,20);
  assert.equal(h.loading,false);
  h.observer.emit(true);
  t.mock.timers.tick(500);
  assert.equal(h.visible,20);
  assert.ok(h.observer.disconnected>0);
});

test('filtering or switching accounts cancels a pending page and its loading indicator', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const old=harness();
  old.observer.emit(true);
  assert.equal(old.loading,true);
  old.cleanup();
  assert.equal(old.loading,false);
  const current=harness();
  old.observer.emit(true);
  t.mock.timers.tick(500);
  assert.equal(old.visible,10);
  assert.equal(current.visible,10);
  current.observer.emit(true);
  t.mock.timers.tick(500);
  assert.equal(current.visible,20);
});

test('scroll fallback also requires the bottom and waits once before loading', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  let scroll, visible=10, loading=false;
  const root={scrollHeight:1000,scrollTop:0,clientHeight:400,
    addEventListener(_name,callback){scroll=callback;},removeEventListener(){scroll=undefined;}};
  const cleanup=observeHistoryPageEnd(root,{},()=>{visible+=10;},undefined,(value)=>{loading=value;});
  root.scrollTop=500;
  scroll();
  assert.equal(loading,false);
  root.scrollTop=600;
  scroll();
  scroll();
  assert.equal(loading,true);
  assert.equal(visible,10);
  t.mock.timers.tick(500);
  assert.equal(visible,20);
  assert.equal(loading,false);
  cleanup();
  assert.equal(scroll,undefined);
});

test('a hidden mobile list cannot start fallback loading', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  let scroll, pages=0, loading=false;
  const root={scrollHeight:0,scrollTop:0,clientHeight:0,
    addEventListener(_name,callback){scroll=callback;},removeEventListener(){}};
  const cleanup=observeHistoryPageEnd(root,{},()=>{pages++;},undefined,(value)=>{loading=value;});
  t.mock.timers.tick(1000);
  assert.equal(pages,0);
  assert.equal(loading,false);
  root.clientHeight=400;
  root.scrollHeight=400;
  scroll();
  assert.equal(loading,true);
  t.mock.timers.tick(500);
  assert.equal(pages,1);
  cleanup();
});
