import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import { formatHelpText } from './workspace-help-text.ts';

const require=createRequire(import.meta.url);
const compiled=await build({entryPoints:[fileURLToPath(new URL('./WorkspaceHelpBadge.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react/jsx-runtime','react-dom'],plugins:[{name:'surfaces',setup(b){
 b.onResolve({filter:/ui\/(Tooltip|Popover)$/},args=>({path:args.path,namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export default function Surface(){return null}',loader:'js'}));
}}]});
const code=compiled.outputFiles[0].text;

test('help text splits Chinese sentences and semicolons while retaining existing lines, IDs, decimals and links',()=>{
 const format=formatHelpText;
 assert.equal(format('第一句。第二句；第三句; 第四句。'),'第一句。\n第二句；\n第三句;\n第四句。');
 assert.equal(format('第一句。\n第二句；\r\n第三句。'),'第一句。\n第二句；\r\n第三句。');
 assert.equal(format('版本 2.5，ID 7174371958：https://example.com/a.b。'), '版本 2.5，ID 7174371958：https://example.com/a.b。');
 assert.equal(format('已完成。 \n保留空行\n\n下一段'),'已完成。 \n保留空行\n\n下一段');
});

test('help badges offer hover/focus text and a tap panel without toggling an enclosing summary',()=>{
 let state=null;
 const rect={left:1,top:2,width:24,height:24};
 const hooks={...React,useRef:()=>({current:{getBoundingClientRect:()=>rect}}),useState:()=>[state,next=>{state=typeof next==='function'?next(state):next} ]};
 const mod={exports:{}};
 new Function('require','module','exports',code)(name=>name==='react'?hooks:require(name),mod,mod.exports);
 const text='辅助解释。\n第二条；\n第三条';
 const render=()=>mod.exports.default({label:'等待中',content:'辅助解释。第二条；第三条'});
 let tree=render(),[tooltip,popover]=tree.props.children;
 let mouseDownStopped=false;tree.props.onMouseDown({stopPropagation(){mouseDownStopped=true}});assert.equal(mouseDownStopped,true,'a trigger click must not be dismissed by the document outside-click handler first');
 assert.equal(tooltip.props.content,text);assert.equal(popover.props.open,false);
 const button=tooltip.props.children;
 assert.equal(button.type,'button');assert.equal(button.props['aria-label'],'等待中说明');
 let prevented=0,stopped=0;
 const click={preventDefault(){prevented++},stopPropagation(){stopped++}};
 button.props.onClick(click);
 assert.equal(prevented,1);assert.equal(stopped,1,'the native details click must not escape');
 [tooltip,popover]=render().props.children;
 assert.equal(tooltip.props.disabled,true);assert.equal(popover.props.open,true);assert.equal(popover.props.children,text);
 assert.match(popover.props.className,/whitespace-pre-line/);
 assert.equal(tooltip.props.children.props['aria-expanded'],true);
 popover.props.onClose();assert.equal(render().props.children[1].props.open,false);
 tooltip.props.children.props.onClick(click);assert.equal(render().props.children[1].props.open,true);
 render().props.children[0].props.children.props.onClick(click);assert.equal(render().props.children[1].props.open,false);
});
