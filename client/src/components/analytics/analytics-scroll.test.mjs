import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsxForTest} from '../ui/tsx-test-helper.mjs';
const {scrollAnalyticsIntoView}=await loadTsxForTest(new URL('./analytics-scroll.ts',import.meta.url).href);
test('定位只滚动统计视口，保留外层页面位置',t=>{
 const calls=[];
 const previous=Object.getOwnPropertyDescriptor(globalThis,'matchMedia');
 Object.defineProperty(globalThis,'matchMedia',{configurable:true,value:()=>({matches:true})});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'matchMedia',previous);else delete globalThis.matchMedia;});
 const viewport={scrollTop:90,clientTop:1,getBoundingClientRect:()=>({top:50}),scrollTo:options=>calls.push(options)};
 const target={closest:selector=>{assert.equal(selector,'.analytics-scroll');return viewport;},getBoundingClientRect:()=>({top:500}),scrollIntoView:()=>assert.fail('不可滚动外层祖先')};
 scrollAnalyticsIntoView(target);assert.deepEqual(calls,[{top:523,behavior:'auto'}]);
 scrollAnalyticsIntoView(null);scrollAnalyticsIntoView({...target,closest:()=>null});assert.equal(calls.length,1);
});
