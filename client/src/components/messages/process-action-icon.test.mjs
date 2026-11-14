import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require=createRequire(import.meta.url);
const result=buildSync({entryPoints:[fileURLToPath(new URL('./ProcessActionIcon.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react/jsx-runtime']});
const module={exports:{}};
new Function('require','module','exports',result.outputFiles[0].text)(require,module,module.exports);
const {default:Icon,getProcessIconKind}=module.exports;

test('类别通道和项目使用固定图标，MCP服务名称变化不会改为动作图标',()=>{
  for(const [key,kind] of [['skill','skill'],['rule','file'],['file','file'],['git','collaboration'],['script','terminal'],['mcp','tool'],['demo · MCP','tool'],['终端','terminal'],['引擎','system'],['助手消息','assistant'],['project','file'],['missing','other']]) assert.equal(getProcessIconKind(key),kind);
});

test('授权命令与执行命令、文件修改等动作不混用图标',()=>{
  for(const [action,kind] of [['允许命令','approval'],['执行命令','terminal'],['修改文件','edit'],['删除文件','remove'],['新增文件','add'],['查看文件','file'],['读取技能','skill'],['网页搜索','web'],['搜索内容','search'],['登记文件变更','report'],['更新计划','plan'],['分析思路','thinking'],['生成图片','image'],['等待回答','question']]) assert.equal(getProcessIconKind(action),kind);
  assert.equal(getProcessIconKind('运行脚本：删除文件.mjs'),'terminal');
  assert.equal(getProcessIconKind('读取技能：权限确认'),'skill');
  assert.equal(getProcessIconKind('调用工具：编辑文件工具'),'tool');
  assert.equal(getProcessIconKind('查看图片'),'image');
  assert.equal(getProcessIconKind('页内查找'),'web');
});

test('动作图标形状区分，显式授权语义优先于命令标题',()=>{
  const kinds=['approval','terminal','edit','question','file','search','report','tool'];
  const shapes=kinds.map(kind=>renderToStaticMarkup(React.createElement(Icon,{kind})).match(/ d="([^"]+)"/)[1]);
  assert.equal(new Set(shapes).size,kinds.length);
  assert.match(renderToStaticMarkup(React.createElement(Icon,{action:'执行命令',kind:'approval'})),/data-process-icon="approval"/);
});
