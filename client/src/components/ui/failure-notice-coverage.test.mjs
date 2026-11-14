import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

test('全站JSX中的异常字符串不得绕过统一展示直接输出',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const violations=[];
  function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()){walk(file);continue;}
    if(!file.endsWith('.tsx')||file.endsWith('AssistantMessage.tsx'))continue;
    const source=fs.readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const visit=node=>{
      if(ts.isJsxExpression(node)&&node.expression&&!ts.isJsxAttribute(node.parent)){
        const text=node.expression.getText(tree);
        if(/^[a-zA-Z]*[Ee]rror$/.test(text)||/^(?:state|gitDiffError)\.(?:error|message)$/.test(text))violations.push(path.relative(root,file));
      }
      ts.forEachChild(node,visit);
    };visit(tree);
  }}
  walk(root);
  assert.deepEqual(violations,[],'异常展示应保留原文并附带说明和处理建议');
});
