import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const compiled=await build({entryPoints:[fileURLToPath(new URL('./WorkspaceDetailUI.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',external:['react','react/jsx-runtime']});
const module={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {Drawer,DetailText,DetailDisclosure}=module.exports;
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
test('drawer has a fixed action header, separate body, back navigation and modal semantics',()=>{
 const html=render(Drawer,{title:'长任务标题',subtitle:'任务 ID：a',onClose(){},onBack(){},onRefresh(){},refreshing:true,children:'任务正文'});
 assert.match(html,/role="dialog" aria-modal="true"/);assert.match(html,/workspace-detail__header/);assert.match(html,/workspace-detail__body/);
 assert.match(html,/返回/);assert.match(html,/disabled=""[^>]*>刷新中/);assert.match(html,/关闭/);
  assert.match(render(Drawer,{title:'任务',onClose(){},suspended:true,children:'保留的任务内容'}),/aria-hidden="true" style="display:none".*保留的任务内容/s);
});
test('short task text stays in place and long task text expands at its own position',()=>{
 assert.equal(render(DetailText,{label:'下一步',text:null}), '');
 assert.doesNotMatch(render(DetailText,{label:'当前情况',text:'等待核验'}),/<details/);
 const long='任务正文'.repeat(60),html=render(DetailText,{label:'任务说明',text:long});
 assert.match(html,/展开全文/);assert.match(html,/<details/);assert.equal(html.split(long).length,2);
});
test('history disclosure supports a collapsed default and an explicit completed-only open state',()=>{
 assert.doesNotMatch(render(DetailDisclosure,{title:'补充信息',children:'记录'}),/open=""/);
 assert.match(render(DetailDisclosure,{title:'已结束交付',children:'记录',open:true}),/open=""/);
});
