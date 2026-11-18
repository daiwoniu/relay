import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { getHostParentPath } from '../chat/host-file-path.ts';
import { formatDateTime } from '../../utils/date-display.ts';
const generationRules=fs.readFileSync(new URL('./generation-rules.md',import.meta.url),'utf8');

const code=ts.transpileModule(fs.readFileSync(new URL('./PageHostingPage.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const stage={uploadId:'upload',previewToken:'token',expiresAt:Date.now()+3600000,entries:['index.html','pages/about.html'],suggestedEntry:'index.html',fileCount:3,totalBytes:1234,rewritten:2,warnings:[],warningCount:0};
function nodes(tree,predicate){if(Array.isArray(tree))return tree.flatMap(node=>nodes(node,predicate));if(!tree||typeof tree!=='object')return [];return [...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)];}
function content(tree){if(Array.isArray(tree))return tree.map(content).join('');if(tree==null||typeof tree==='boolean')return '';if(typeof tree!=='object')return String(tree);return content(tree.props?.children);}
function harness(t,overrides={},given={}){
  let cursor=0;const slots=[],effects=[],calls=[];
  const hooks={
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]={value:typeof initial==='function'?initial():initial};return [slots[index].value,value=>{slots[index].value=typeof value==='function'?value(slots[index].value):value;}];},
    useRef(value){const index=cursor++;if(!(index in slots))slots[index]={current:value};return slots[index];},
    useEffect(effect,deps){const index=cursor++,prior=slots[index];if(!prior||deps.some((value,i)=>value!==prior.deps[i])){slots[index]={deps,cleanup:prior?.cleanup};effects.push(()=>{slots[index].cleanup?.();slots[index].cleanup=effect();});}},
    lazy:()=>()=>null,Suspense:({children})=>children,
  };
  const api={
    uploadHostedFile:async(...args)=>{calls.push(['upload',...args]);return stage;},
    importHostedFiles:async(...args)=>{calls.push(['import',...args]);return stage;},
    cancelHostedUpload:async id=>{calls.push(['cancel',id]);},
    publishHostedSite:async input=>{calls.push(['publish',input]);return {site:{id:'published',enabled:true}};},
    hostedPreviewUrl:(_stage,entry)=>`/preview/${entry}`,
    hostedUrl:id=>`/p/${id}/`,
    ...overrides,
  };
  const module={exports:{}};
  new Function('require','module','exports',code)(name=>{
    if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx;if(name==='../../api/page-hosting')return api;
    if(name==='../../auth/AuthContext')return {useAuth:()=>({user:given.authUser??{role:'member'}})};
    if(name==='../../stores/chat')return {useChatStore:selector=>selector({toggleSidebar(){}})};
    if(name==='../chat/host-file-path')return {getHostParentPath};
    if(name==='../../utils/date-display.ts')return {formatDateTime};
    if(name==='./generation-rules.md?raw')return {default:generationRules};
    if(name==='../../utils/clipboard')return {copyToClipboard:async text=>{calls.push(['copy',text]);if(given.copyError)throw given.copyError;}};
    return {default:()=>null};
  },module,module.exports);
  const props={site:null,onClose(){calls.push(['close']);},onPublished(site){calls.push(['published',site]);},...given};
  const render=()=>{cursor=0;return module.exports.UploadDialog(props);};
  const flush=()=>{for(const effect of effects.splice(0))effect();};
  const cleanup=()=>{for(const slot of slots)slot?.cleanup?.();};t.after(cleanup);
  return {render,flush,cleanup,calls,page:()=>{cursor=0;return module.exports.default(given.pageProps);}};
}
const button=(tree,label)=>nodes(tree,node=>node.type==='button'&&content(node)===label)[0];
const input=(tree,placeholder)=>nodes(tree,node=>node.type==='input'&&node.props.placeholder===placeholder)[0];

test('generation rules copy the full portable document and report success without publishing',async t=>{
  const h=harness(t,{listHostedSites:async()=>({sites:[]})},{authUser:{id:'admin',role:'admin'}});
  h.page();h.flush();await settle();
  button(h.page(),'复制 AI 生成规则').props.onClick();await settle();
  assert.equal(h.calls.find(call=>call[0]==='copy')[1],generationRules);
  assert.match(content(h.page()),/AI 生成规则已复制/);
  assert.equal(h.calls.some(call=>['upload','import','publish'].includes(call[0])),false);
});

test('generation rules surface clipboard failures without claiming success',async t=>{
  const failure=new Error('复制失败，请重试');
  const h=harness(t,{listHostedSites:async()=>({sites:[]})},{authUser:{id:'admin',role:'admin'},copyError:failure});
  h.page();h.flush();await settle();button(h.page(),'复制 AI 生成规则').props.onClick();await settle();
  assert.ok(nodes(h.page(),node=>node.props?.error===failure).length);
  assert.doesNotMatch(content(h.page()),/AI 生成规则已复制/);
});

test('documented static extensions match the hosting allowlist',()=>{
  const source=fs.readFileSync(new URL('../../../../server/src/page-hosting/file-paths.ts',import.meta.url),'utf8');
  const expected=source.match(/new Set\('([^']+)'\.split/)[1].split(' ').sort();
  const actual=[...generationRules.matchAll(/^\|[^|]+\| ([a-z0-9 ]+) \|$/gm)].flatMap(match=>match[1].split(' ')).sort();
  assert.deepEqual(actual,expected);
});

test('copying rules preserves a failed list request and does not attach list refresh to copy failure',async t=>{
  const listFailure=new Error('列表加载失败'),copyFailure=new Error('剪贴板不可用');
  const given={authUser:{id:'admin',role:'admin'},copyError:copyFailure};
  const h=harness(t,{listHostedSites:async()=>{throw listFailure;}},given);
  h.page();h.flush();await settle();button(h.page(),'复制 AI 生成规则').props.onClick();await settle();
  let tree=h.page();
  assert.ok(nodes(tree,node=>node.props?.error===listFailure).length);
  assert.ok(nodes(tree,node=>node.props?.error===copyFailure).length);
  const alert=nodes(tree,node=>node.props?.role==='alert')[0];
  assert.equal(button(alert,'刷新列表'),undefined);
  given.copyError=null;button(tree,'复制 AI 生成规则').props.onClick();await settle();tree=h.page();
  assert.ok(nodes(tree,node=>node.props?.error===listFailure).length);
  assert.equal(nodes(tree,node=>node.props?.error===copyFailure).length,0);
  assert.match(content(tree),/AI 生成规则已复制/);
});

test('local file and directory pickers share the last selected directory across dialog openings',t=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),saved=new Map();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)}});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'localStorage',prior);else delete globalThis.localStorage;});
  const selectPicker=tree=>nodes(tree,node=>typeof node.props?.onSelect==='function'&&typeof node.props?.onCancel==='function')[0];
  const h=harness(t,{}, {authUser:{id:'admin',role:'admin'}});
  h.render();button(h.render(),'从本机导入').props.onClick();button(h.render(),'选择文件 / ZIP').props.onClick();
  assert.equal(selectPicker(h.render()).props.initialPath,'');
  selectPicker(h.render()).props.onSelect([{path:'D:\\sites\\demo.zip'}]);
  button(h.render(),'选择目录').props.onClick();assert.equal(selectPicker(h.render()).props.initialPath,'D:\\sites');
  selectPicker(h.render()).props.onSelect('D:\\sites\\demo');
  const reopened=harness(t,{}, {authUser:{id:'admin',role:'admin'}});
  reopened.render();button(reopened.render(),'从本机导入').props.onClick();button(reopened.render(),'选择文件 / ZIP').props.onClick();
  assert.equal(selectPicker(reopened.render()).props.initialPath,'D:\\sites\\demo');
  const other=harness(t,{}, {authUser:{id:'other',role:'admin'}});
  other.render();button(other.render(),'从本机导入').props.onClick();button(other.render(),'选择目录').props.onClick();
  assert.equal(selectPicker(other.render()).props.initialPath,'');
});

test('management panel uses shared shell and suspends it while the upload dialog is open',async t=>{
  const onClose=()=>{};
  const h=harness(t,{listHostedSites:async()=>({sites:[]})},{authUser:{id:'admin',role:'admin'},pageProps:{onClose,mobile:true}});
  let tree=h.page();h.flush();await settle();tree=h.page();
  assert.equal(tree.props.titleId,'page-hosting-title');assert.equal(tree.props.mobile,true);assert.equal(tree.props.onClose,onClose);assert.equal(tree.props.suspended,false);
  assert.equal(nodes(tree,node=>node.props?.['aria-label']==='打开侧栏').length,0);
  button(tree,'添加页面').props.onClick();tree=h.page();assert.equal(tree.props.suspended,true);
});

test('management links use the short address and retain UUID fallback for older sites',async t=>{
  const site={id:'550e8400-e29b-41d4-a716-446655440000',publicId:'k7m2x9a4bt',name:'Site',enabled:true,entry:'index.html',totalBytes:13,fileCount:1,updatedAt:1};
  const h=harness(t,{listHostedSites:async()=>({sites:[site,{...site,id:'legacy',publicId:undefined}]})},{authUser:{id:'admin',role:'admin'}});
  h.page();h.flush();await settle();
  assert.deepEqual(nodes(h.page(),node=>node.type==='a'&&content(node)==='打开').map(node=>node.props.href),['/p/k7m2x9a4bt/','/p/legacy/']);
});

test('more actions remain a dropdown while management stays visible and hand off to rename',async t=>{
  const site={id:'site',name:'My site',enabled:true,entry:'index.html',totalBytes:13,fileCount:1,updatedAt:1};
  const h=harness(t,{listHostedSites:async()=>({sites:[site]})},{authUser:{id:'admin',role:'admin'},pageProps:{onClose(){},mobile:true}});
  h.page();h.flush();await settle();let tree=h.page();
  assert.match(content(tree),/共 1 个托管页面/);
  assert.equal(nodes(tree,node=>node.type==='details').length,0);
  const anchor={};button(tree,'更多').props.onClick({currentTarget:anchor});tree=h.page();assert.equal(tree.props.suspended,false);assert.equal(tree.props.closeOnEscape,false);
  const menu=nodes(tree,node=>typeof node.props?.onAction==='function')[0];assert.equal(menu.props.anchor,anchor);assert.equal(menu.props.site.id,site.id);
  menu.props.onAction('rename');tree=h.page();
  assert.equal(nodes(tree,node=>typeof node.props?.onAction==='function').length,0);assert.equal(nodes(tree,node=>node.props?.labelledBy==='hosting-rename-title')[0].props.open,true);assert.equal(tree.props.suspended,true);
});

test('local import submits only server path and reuses inspection, homepage and publication',async t=>{
  const h=harness(t);h.render();h.flush();button(h.render(),'从本机导入').props.onClick();
  input(h.render(),'服务器上的绝对路径').props.onChange({target:{value:'D:/site'}});
  button(h.render(),'导入并检查').props.onClick();await settle();
  assert.equal(h.calls.filter(call=>call[0]==='upload').length,0);assert.equal(h.calls.find(call=>call[0]==='import')[1],'D:/site');
  let tree=h.render();assert.equal(nodes(tree,node=>node.type==='select')[0].props.value,'index.html');
  assert.equal(nodes(tree,node=>node.type==='a'&&content(node)==='预览')[0].props.href,'/preview/index.html');
  assert.equal(button(tree,'发布').props.disabled,false);await button(tree,'发布').props.onClick();await settle();
  assert.deepEqual(h.calls.find(call=>call[0]==='publish')[1],{uploadId:'upload',name:'site',entry:'index.html'});
  assert.ok(h.calls.some(call=>call[0]==='published'));
});

test('upload rejects oversized browser file without transmitting bytes and retains name for retry',async t=>{
  const h=harness(t);h.render();h.flush();const choose=nodes(h.render(),node=>node.type==='input'&&node.props.type==='file')[0];
  choose.props.onChange({target:{files:[{name:'large.zip',size:33*1024*1024}]}});
  await button(h.render(),'上传并检查').props.onClick();await settle();
  assert.equal(h.calls.filter(call=>call[0]==='upload').length,0);assert.equal(input(h.render(),'例如：产品介绍').props.value,'large');
  nodes(h.render(),node=>node.type==='input'&&node.props.type==='file')[0].props.onChange({target:{files:[{name:'small.zip',size:1024}]}});
  await button(h.render(),'上传并检查').props.onClick();await settle();assert.equal(h.calls.filter(call=>call[0]==='upload').length,1);
});

test('ambiguous homepage blocks publish until selected',async t=>{
  const h=harness(t,{importHostedFiles:async()=>({...stage,suggestedEntry:null})});h.render();h.flush();button(h.render(),'从本机导入').props.onClick();input(h.render(),'服务器上的绝对路径').props.onChange({target:{value:'D:/site'}});
  await button(h.render(),'导入并检查').props.onClick();await settle();assert.equal(button(h.render(),'发布').props.disabled,true);
  nodes(h.render(),node=>node.type==='select')[0].props.onChange({target:{value:'pages/about.html'}});assert.equal(button(h.render(),'发布').props.disabled,false);
});

test('failure preserves local selection, restores retry button and surfaces inspection error',async t=>{
  let attempt=0;const h=harness(t,{importHostedFiles:async()=>{if(!attempt++)throw Error('目录包含链接');return stage;}});
  h.render();h.flush();button(h.render(),'从本机导入').props.onClick();input(h.render(),'服务器上的绝对路径').props.onChange({target:{value:'D:/site'}});
  await button(h.render(),'导入并检查').props.onClick();await settle();assert.equal(input(h.render(),'服务器上的绝对路径').props.value,'D:/site');assert.equal(button(h.render(),'导入并检查').props.disabled,false);
  assert.ok(nodes(h.render(),node=>node.props?.error?.message==='目录包含链接').length);
  await button(h.render(),'导入并检查').props.onClick();await settle();assert.ok(button(h.render(),'发布'));
});

test('replacement retains existing homepage and submits the original site identity and concurrency token',async t=>{
  const site={id:'fixed-site',contentToken:'original-token',name:'Existing',entry:'pages/about.html'};
  const h=harness(t,{}, {site});h.render();h.flush();button(h.render(),'从本机导入').props.onClick();input(h.render(),'服务器上的绝对路径').props.onChange({target:{value:'D:/new-site'}});
  await button(h.render(),'导入并检查').props.onClick();await settle();
  assert.equal(nodes(h.render(),node=>node.type==='select')[0].props.value,'pages/about.html');
  button(h.render(),'替换并发布').props.onClick();await settle();
  assert.deepEqual(h.calls.find(call=>call[0]==='publish')[1],{uploadId:'upload',name:'Existing',entry:'pages/about.html',siteId:'fixed-site',expectedToken:'original-token'});
});

test('leaving during an import aborts request and discards late temporary content',async t=>{
  let complete,signal;const pending=new Promise(resolve=>{complete=resolve;});
  const h=harness(t,{importHostedFiles:(_path,value)=>{signal=value;return pending;}});h.render();h.flush();button(h.render(),'从本机导入').props.onClick();input(h.render(),'服务器上的绝对路径').props.onChange({target:{value:'D:/site'}});
  button(h.render(),'导入并检查').props.onClick();h.cleanup();assert.equal(signal.aborted,true);complete(stage);await settle();assert.ok(h.calls.some(call=>call[0]==='cancel'&&call[1]==='upload'));assert.equal(h.calls.filter(call=>call[0]==='publish').length,0);
});

test('member cannot render management actions or start list requests',t=>{
  const h=harness(t);const tree=h.page();h.flush();assert.match(content(tree),/仅管理员/);assert.equal(nodes(tree,node=>node.type==='button').length,0);assert.deepEqual(h.calls,[]);
});

test('admin cannot start an addition before the initial list has settled',async t=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const h=harness(t,{listHostedSites:()=>pending},{authUser:{id:'admin',role:'admin'}});
  let tree=h.page();h.flush();assert.equal(button(tree,'添加页面').props.disabled,true);
  finish({sites:[]});await settle();tree=h.page();assert.equal(button(tree,'添加页面').props.disabled,false);
});

test('late publication completion does not update a page that has already unmounted',async t=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const h=harness(t,{publishHostedSite:()=>pending});h.render();h.flush();button(h.render(),'从本机导入').props.onClick();input(h.render(),'服务器上的绝对路径').props.onChange({target:{value:'D:/site'}});
  await button(h.render(),'导入并检查').props.onClick();await settle();button(h.render(),'发布').props.onClick();h.cleanup();finish({site:{id:'new',enabled:true}});await settle();
  assert.equal(h.calls.filter(call=>call[0]==='published').length,0);
});
