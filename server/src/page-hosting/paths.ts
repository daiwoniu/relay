import path from 'node:path';
import ts from 'typescript';
import { encodePath } from './file-paths.js';
export { safePackagePath,isStaticFile,encodePath } from './file-paths.js';


/** Parse static module declarations with the installed TS parser; never scan executable strings. */
function moduleReferences(source:string,reference:(value:string)=>string,onInvalid:()=>void){
  const parsed=ts.createSourceFile('hosted.js',source,ts.ScriptTarget.Latest,false,ts.ScriptKind.JS);
  if((parsed as ts.SourceFile&{parseDiagnostics:readonly unknown[]}).parseDiagnostics.length){onInvalid();return source;}
  const edits:Array<{start:number;end:number;value:string}>=[];
  const visit=(node:ts.Node)=>{
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)){
      const specifier=node.moduleSpecifier,value=specifier.text;
      if(/^(?:[./]|file:|[a-z]:[\\/])/i.test(value)){
        const changed=reference(value);
        if(changed!==value)edits.push({start:specifier.getStart(parsed)+1,end:specifier.getEnd()-1,value:changed});
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(parsed);
  let text=source;for(const edit of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,edit.start)+edit.value+text.slice(edit.end);return text;
}
function cssReferences(source:string,reference:(value:string)=>string){
  let text='',offset=0;
  while(offset<source.length){
    if(source.startsWith('/*',offset)){const end=source.indexOf('*/',offset+2),next=end<0?source.length:end+2;text+=source.slice(offset,next);offset=next;continue;}
    const rest=source.slice(offset),boundary=offset===0||!/[\w-]/.test(source[offset-1]);
    const url=boundary?/^url\(\s*(['"]?)([^'"()]*?)\1\s*\)/i.exec(rest):null,imp=boundary?/^(@import\s+)(['"])([^'"]+)\2/i.exec(rest):null;
    if(url){text+=`url(${url[1]}${reference(url[2])}${url[1]})`;offset+=url[0].length;continue;}
    if(imp){text+=`${imp[1]}${imp[2]}${reference(imp[3])}${imp[2]}`;offset+=imp[0].length;continue;}
    const char=source[offset];
    if(char==='"'||char==="'"){let end=offset+1;while(end<source.length){if(source[end]==='\\')end+=2;else if(source[end++]===char)break;}text+=source.slice(offset,end);offset=end;continue;}
    text+=char;offset++;
  }return text;
}

/** Rewrite only syntactically identified references; never replace arbitrary JS strings. */
export function rewriteReferences(filename: string, source: string, files: Set<string>) {
  let rewritten = 0, warningCount = 0;
  const warnings: string[] = [];
  const warn = (value: string) => { warningCount++; if (warnings.length < 40) warnings.push(`${filename}：${value.slice(0, 180)}`); };
  const reference = (raw: string) => {
    const value = raw.trim();
    if (!value || /^(?:https?:|\/\/|#|data:|blob:|mailto:|tel:)/i.test(value)) return raw;
    if (/^[a-z][\w+.-]*:/i.test(value) && !/^(?:file:|[a-z]:[\\/])/i.test(value)) return raw;
    const local = /^(?:file:|[a-z]:[\\/])/i.test(value);
    const slash = value.replace(/\\/g, '/').replace(/^file:\/*/i, '');
    const split = slash.search(/[?#]/), pathname = split < 0 ? slash : slash.slice(0, split), suffix = split < 0 ? '' : slash.slice(split);
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { warn(value); return raw; }
    let target: string | undefined;
    if (local) {
      // An absolute local reference needs an unambiguous directory suffix, not a basename guess.
      const parts = decoded.replace(/^[a-z]:\//i, '').split('/').filter(Boolean);
      for (let count = parts.length; count >= 2; count--) {
        const tail = parts.slice(-count).join('/').toLowerCase();
        const candidates = [...files].filter(file => file.toLowerCase() === tail);
        if (candidates.length === 1) { target = candidates[0]; break; }
      }
    } else {
      const candidate = decoded.startsWith('/') ? path.posix.normalize(decoded).slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(filename), decoded));
      if (files.has(candidate)) target = candidate;
      else if (files.has(`${candidate.replace(/\/$/, '')}/index.html`)) target = `${candidate.replace(/\/$/, '')}/index.html`;
    }
    if (!target) { warn(value); return raw; }
    if (!local && !pathname.startsWith('/') && !raw.includes('\\')) return raw;
    let relative = path.posix.relative(path.posix.dirname(filename), target);
    if (!relative.startsWith('.')) relative = `./${relative}`;
    rewritten++;
    return encodePath(relative) + suffix;
  };
  const css = (value: string) => cssReferences(value,reference);
  const srcset=(value:string)=>{
    if(/data:/i.test(value)){warn('srcset 包含内嵌资源，请人工检查');return value;}
    const edits:Array<{start:number;end:number;value:string}>=[];let offset=0;
    while(offset<value.length){
      while(offset<value.length&&/[\s,]/.test(value[offset]))offset++;
      const start=offset;while(offset<value.length&&!/\s/.test(value[offset]))offset++;
      const token=value.slice(start,offset),url=token.replace(/,+$/,'');
      if(url){const changed=reference(url);if(changed!==url)edits.push({start,end:start+url.length,value:changed});}
      if(url.length<token.length)continue;
      let depth=0;while(offset<value.length){const char=value[offset++];if(char==='(')depth++;else if(char===')')depth--;else if(char===','&&depth<=0)break;}
    }
    let result=value;for(const edit of edits.reverse())result=result.slice(0,edit.start)+edit.value+result.slice(edit.end);return result;
  };
  const ext = path.posix.extname(filename).toLowerCase();
  let text = source;
  if (ext === '.html' || ext === '.htm') {
    // Skip comments and script bodies so HTML-looking strings inside JS stay untouched.
    text = text.replace(/<!--[\s\S]*?-->|<script\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/script\s*>|<style\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/style\s*>|<[a-z](?:"[^"]*"|'[^']*'|[^'">])*>/gi, tag => {
      if (tag.startsWith('<!--')) return tag;
      const opening=/^<(?:"[^"]*"|'[^']*'|[^'">])*>/.exec(tag)?.[0]??tag;
      let rest=tag.slice(opening.length);
      const changed=opening.replace(/(\s+)([^\s"'<>/=]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
        (match,space:string,attr:string,equals:string,double:string|undefined,single:string|undefined,bare:string|undefined)=>{
          const value=double??single??bare??'',q=double!==undefined?'"':single!==undefined?"'":'',name=attr.toLowerCase();let replacement=value;
          if(['src','href','poster','data'].includes(name))replacement=reference(value);
          else if(name==='style')replacement=css(value);
          else if(name==='srcset')replacement=srcset(value);
          return `${space}${attr}${equals}${q}${replacement}${q}`;
        });
      if(/^<style\b/i.test(opening))rest=css(rest);
      if(/^<script\b/i.test(opening)&&/\btype\s*=\s*(?:"module"|'module'|module(?=[\s>]))/i.test(opening)){
        const end=rest.toLowerCase().lastIndexOf('</script');
        rest=moduleReferences(rest.slice(0,end),reference,()=>warn('模块脚本语法未能完整解析，静态引用保持原样'))+rest.slice(end);
      }
      return changed+rest;
    });
    if (/<base\b/i.test(source)) warn('包含 base 标签，可能改变相对路径，请预览确认');
    if (/<script\b[^>]*>\s*[^<]/i.test(source)) warn('内联脚本的动态路径保持原样，请预览确认');
  } else if (ext === '.css') text = css(text);
  else if (ext === '.js' || ext === '.mjs') {
    // Conservative module-specifier scan; other strings and runtime URLs stay intact.
    text = moduleReferences(text,reference,()=>warn('脚本语法未能完整解析，静态模块引用保持原样'));
    if(/\b(?:fetch\s*\(|import\s*\(|new\s+URL\s*\()/i.test(source))warn('脚本动态引用保持原样，请预览确认');
  }
  return { text, rewritten, warnings, warningCount };
}
