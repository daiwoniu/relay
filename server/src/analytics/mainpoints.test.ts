import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync,readFileSync } from 'node:fs';
import { join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ANALYTICS_FEATURES,findAnalyticsRegistration } from './registry.js';

test('所有可静态解析的真实客户端主点均已登记，入口/producer/结果与关联规则匹配',()=>{
  const root=fileURLToPath(new URL('../../../client/src',import.meta.url)),errors:string[]=[];let checked=0;
  function strings(node:ts.Expression|undefined):string[]{
    if(!node)return[];if(ts.isStringLiteralLike(node))return[node.text];
    if(ts.isConditionalExpression(node))return[...strings(node.whenTrue),...strings(node.whenFalse)];
    if(ts.isAsExpression(node)||ts.isParenthesizedExpression(node))return strings(node.expression);return[];
  }
  function object(node:ts.Expression|undefined){
    const fields=new Map<string,ts.Expression>();
    if(node&&ts.isObjectLiteralExpression(node))for(const p of node.properties){
      if(ts.isPropertyAssignment(p))fields.set(p.name.getText(),p.initializer);
      if(ts.isShorthandPropertyAssignment(p))fields.set(p.name.text,p.name);
    }return fields;
  }
  function validate(file:string,node:ts.Node,name:string,fields:Map<string,ts.Expression>,helper?:string){
    for(const feature of strings(fields.get('feature')))for(const action of strings(fields.get('action'))){
      checked++;const entry=findAnalyticsRegistration(name,feature,action),at=`${relative(root,file)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line+1} ${feature}.${action}`;
      if(!entry||entry.producer!=='client'){errors.push(`${at}: 未登记客户端主点`);continue;}
      for(const surface of strings(fields.get('surface')))if(surface!=='unknown'&&!(ANALYTICS_FEATURES[entry.feature].surfaces as readonly string[]).includes(surface))errors.push(`${at}: 入口不匹配 ${surface}`);
      if(helper==='localAction'&&entry.outcome!=='required')errors.push(`${at}: 本地结果主点不匹配`);
      if(helper==='featureAction'&&entry.outcome!=='none')errors.push(`${at}: 缺少本地结果`);
      if(!helper&&entry.outcome==='required'&&!fields.has('result'))errors.push(`${at}: 缺少结果`);
      if(!helper&&entry.correlated&&!fields.has('operationId'))errors.push(`${at}: 缺少关联ID`);
      if(entry.toolIds&&!fields.has('toolId'))errors.push(`${at}: 缺少工具标识`);
    }
  }
  function walk(directory:string){for(const entry of readdirSync(directory,{withFileTypes:true})){
    const file=join(directory,entry.name);if(entry.isDirectory()){if(entry.name!=='generated')walk(file);continue;}
    if(!/\.tsx?$/.test(entry.name)||/\.test\./.test(entry.name))continue;
    const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    function visit(node:ts.Node){
      if(ts.isCallExpression(node)){
        const call=node.expression.getText(source);
        if(['useFeatureView','featureAction','localAction','remoteIntent'].includes(call)){
          const fields=new Map<string,ts.Expression>();fields.set('feature',node.arguments[0]);
          fields.set('action',call==='useFeatureView'?(node.arguments[3]??ts.factory.createStringLiteral('open')):node.arguments[1]);
          fields.set('surface',node.arguments[2]);validate(file,node,call==='useFeatureView'?'feature_view':'feature_action',fields,call);
        }else if(['tracker.action','tracker.result','tracker.track'].includes(call)){
          const name=call==='tracker.action'?'feature_action':call==='tracker.result'?'operation_result':strings(node.arguments[0])[0];
          if(['feature_view','feature_action','operation_result'].includes(name))validate(file,node,name,object(node.arguments[call==='tracker.track'?1:0]));
        }
      }
      if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='analytics')validate(file,node,'feature_action',object(node.initializer),'requestJson');
      ts.forEachChild(node,visit);
    }visit(source);
  }}walk(root);
  assert.ok(checked>80,`实际主点检查范围不足：${checked}`);assert.deepEqual(errors,[]);
});
