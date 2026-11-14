import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type Route={method:string;path:string};
function* sources(root:string):Generator<string>{
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    const filename=path.join(root,entry.name);
    if(entry.isDirectory())yield* sources(filename);
    else if(/\.(ts|tsx)$/.test(entry.name)&&!entry.name.includes('.test.'))yield filename;
  }
}
/** Compare client URL expressions with the actual mounted routes, including HTTP methods where explicit. */
export function uncoveredClientApiRoutes(routes:Route[],root=path.resolve('../client/src')){
  const missing:Array<{file:string;line:number;method:string;url:string}>=[];
  for(const filename of sources(root)){
    const source=ts.createSourceFile(filename,fs.readFileSync(filename,'utf8'),ts.ScriptTarget.Latest,true);
    function visit(node:ts.Node){
      const url=ts.isStringLiteralLike(node)?node.text:ts.isTemplateExpression(node)
        ?node.head.text+node.templateSpans.map(span=>'__value__'+span.literal.text).join(''):null;
      if(url?.startsWith('/api/')){
        const pathname=url.split('?')[0]!.replace(/([^/])__value__$/,'$1'),parts=pathname.split('/').filter(Boolean),call=node.parent;
        let method:string|undefined;
        if(ts.isCallExpression(call)&&['requestJson','fetch'].includes(call.expression.getText(source))){
          method='GET';const options=call.arguments[1];
          if(options&&ts.isObjectLiteralExpression(options))for(const prop of options.properties){
            if(ts.isPropertyAssignment(prop)&&prop.name.getText(source)==='method'&&ts.isStringLiteralLike(prop.initializer))method=prop.initializer.text;
          }
        }
        const found=routes.some(route=>{
          if(route.method==='ALL'||method&&route.method!==method)return false;
          const target=route.path.split('/').filter(Boolean);
          return target.length===parts.length&&target.every((part,i)=>part.startsWith(':')||parts[i]==='__value__'||part===parts[i]);
        });
        if(!found)missing.push({file:path.relative(root,filename),line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,method:method??'ANY',url:pathname});
      }
      ts.forEachChild(node,visit);
    }
    visit(source);
  }
  return missing;
}
