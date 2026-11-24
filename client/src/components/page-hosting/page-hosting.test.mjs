import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { getHostParentPath } from '../chat/host-file-path.ts';
import { formatDateTime } from '../../utils/date-display.ts';
import * as hostingSummary from './hosting-summary.ts';
const generationRules=fs.readFileSync(new URL('./generation-rules.md',import.meta.url),'utf8');

const code=ts.transpileModule(fs.readFileSync(new URL('./PageHostingPage.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const previewCode=ts.transpileModule(fs.readFileSync(new URL('./PreviewHostingDialog.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
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
  const module={exports:{}},previewModule={exports:{}};
  const resolve=name=>{
    if(name==='./PreviewHostingDialog')return previewModule.exports;
    if(name==='./hosting-summary')return hostingSummary;
    if(name==='../../analytics/features')return {featureAction(){},localAction:()=>()=>{},useFeatureView(){}};
    if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx;if(name==='../../api/page-hosting')return api;
    if(name==='../../auth/AuthContext')return {useAuth:()=>({user:given.authUser??{role:'member'}})};
    if(name==='../../stores/chat')return {useChatStore:selector=>selector({toggleSidebar(){}})};
    if(name==='../chat/host-file-path')return {getHostParentPath};
    if(name==='../../utils/date-display.ts')return {formatDateTime};
    if(name==='./generation-rules.md?raw')return {default:generationRules};
    if(name==='../../utils/clipboard')return {copyToClipboard:async text=>{calls.push(['copy',text]);if(given.copyError)throw given.copyError;}};
    return {default:()=>null};
  };
  new Function('require','module','exports',previewCode)(resolve,previewModule,previewModule.exports);
  new Function('require','module','exports',code)(resolve,module,module.exports);
  const props={site:null,onClose(){calls.push(['close']);},onPublished(site){calls.push(['published',site]);},...given};
  const render=()=>{cursor=0;const tree=module.exports.UploadDialog(props);return tree.type===previewModule.exports.default?tree.type(tree.props):tree;};
  const flush=()=>{for(const effect of effects.splice(0))effect();};
  const cleanup=()=>{for(const slot of slots)slot?.cleanup?.();};t.after(cleanup);
  return {render,flush,cleanup,calls,props,page:()=>{cursor=0;return module.exports.default(given.pageProps);}};
}
const button=(tree,label)=>nodes(tree,node=>node.type==='button'&&content(node)===label)[0];
const input=(tree,placeholder)=>nodes(tree,node=>node.type==='input'&&node.props.placeholder===placeholder)[0];
const choice=(tree,label)=>nodes(tree,node=>node.props?.label===label&&Array.isArray(node.props?.options))[0];

for (const preview of [true, false]) test(`inspection summary appears after checking with complete metadata (${preview ? 'preview' : 'normal'})`, async t => {
  const result = {...stage, fileCount:1, totalBytes:1153434, rewritten:0, warnings:['检查提示'], warningCount:1};
  const h = harness(t, {importHostedFiles:async()=>result}, preview ? {initialLocalPath:'D:/site/index.html'} : {});
  let tree=h.render();h.flush();
  if(!preview){button(tree,'从本机导入').props.onClick();tree=h.render();input(tree,'服务器上的绝对路径').props.onChange({target:{value:'D:/site/index.html'}});tree=h.render();}
  assert.equal(nodes(tree,node=>node.props?.className==='hosting-summary').length,0);
  button(tree,preview?'检查页面':'导入并检查').props.onClick();await settle();tree=h.render();
  const summaries=nodes(tree,node=>node.props?.className==='hosting-summary');
  assert.equal(summaries.length,1);
  assert.equal(content(summaries[0]),'共 1 个文件 · 1.1 MB · 已修正 0 处路径 · 1 项提示');
});

test('preview form imports the current file or directory without irrelevant source controls',async t=>{
  const h=harness(t,{importHostedFiles:async(...args)=>{h.calls.push(['import',...args]);return {...stage,entries:['index.html','about.html']};}}, {initialLocalPath:'D:/site/pages/about.html'});
  let tree=h.render();h.flush();
  assert.match(content(tree),/D:\/site\/pages\/about.html/);
  assert.equal(button(tree,'上传文件'),undefined);
  assert.equal(button(tree,'选择文件 / ZIP'),undefined);
  assert.equal(nodes(tree,node=>node.type==='input'&&node.props.type==='file').length,0);
  assert.equal(h.calls.length,0);
  nodes(tree,node=>node.type==='input'&&node.props.type==='checkbox')[0].props.onChange({target:{checked:true}});tree=h.render();
  button(tree,'检查页面').props.onClick();await settle();tree=h.render();
  assert.equal(h.calls.find(call=>call[0]==='import')[1],'D:/site/pages');
  assert.equal(nodes(tree,node=>node.type==='a'&&content(node)==='预览')[0].props.href,'/preview/about.html');
  assert.ok(choice(tree,'发布到'));assert.equal(choice(tree,'打开的页面'),undefined);
  assert.equal(h.calls.some(call=>call[0]==='publish'),false);
});

test('preview updates a selected hosted page using its name and concurrency token',async t=>{
  const site={id:'existing',name:'已有页面',entry:'index.html',contentToken:'old-token',enabled:false};
  const h=harness(t,{}, {initialLocalPath:'D:/site/index.html',sites:[site]});
  let tree=h.render();h.flush();
  choice(tree,'发布到').props.onChange(site.id);
  tree=h.render();assert.match(content(tree),/更新后仍保持停用/);
  button(tree,'检查页面').props.onClick();await settle();tree=h.render();
  button(tree,'更新托管').props.onClick();await settle();
  assert.deepEqual(h.calls.find(call=>call[0]==='publish')[1],{uploadId:'upload',name:'已有页面',entry:'index.html',siteId:'existing',expectedToken:'old-token'});
});

test('changing preview resource scope discards the prior inspection before importing again',async t=>{
  const h=harness(t,{}, {initialLocalPath:'D:/site/about.html'});
  let tree=h.render();h.flush();button(tree,'检查页面').props.onClick();await settle();tree=h.render();
  nodes(tree,node=>node.type==='input'&&node.props.type==='checkbox')[0].props.onChange({target:{checked:true}});await settle();tree=h.render();
  assert.ok(h.calls.find(call=>call[0]==='cancel'));
  assert.equal(button(tree,'发布'),undefined);
  assert.equal(nodes(tree,node=>node.props?.className==='hosting-summary').length,0);
  button(tree,'检查页面').props.onClick();await settle();
  assert.equal(h.calls.filter(call=>call[0]==='import').at(-1)[1],'D:/site');
});

test('failed scope cleanup preserves the inspected source and can be retried',async t=>{
  const failure=new Error('清理失败');
  const h=harness(t,{cancelHostedUpload:async()=>{throw failure;}},{initialLocalPath:'D:/site/index.html'});
  let tree=h.render();h.flush();button(tree,'检查页面').props.onClick();await settle();tree=h.render();
  nodes(tree,node=>node.type==='input'&&node.props.type==='checkbox')[0].props.onChange({target:{checked:true}});await settle();tree=h.render();
  assert.equal(nodes(tree,node=>node.type==='input'&&node.props.type==='checkbox')[0].props.checked,false);
  assert.ok(button(tree,'发布'));
  assert.ok(nodes(tree,node=>node.props?.error===failure).length);
});

test('failed preview update retains its selected target and does not report success',async t=>{
  const failure=new Error('页面已被更新，请重新选择');
  const site={id:'existing',name:'已有页面',entry:'index.html',contentToken:'selected-token',enabled:true};
  const h=harness(t,{publishHostedSite:async()=>{throw failure;}},{initialLocalPath:'D:/site/index.html',sites:[site]});
  let tree=h.render();h.flush();choice(tree,'发布到').props.onChange(site.id);
  tree=h.render();button(tree,'检查页面').props.onClick();await settle();tree=h.render();
  button(tree,'更新托管').props.onClick();await settle();tree=h.render();
  assert.equal(choice(tree,'发布到').props.value,'existing');
  assert.ok(nodes(tree,node=>node.props?.error===failure).length);
  assert.equal(h.calls.some(call=>call[0]==='published'),false);
});

test('update retries wait for refreshed targets and use a newly selected version',async t=>{
  const site={id:'existing',name:'已有页面',entry:'index.html',contentToken:'old',enabled:true};
  const submitted=[];let reloads=0;
  const h=harness(t,{publishHostedSite:async input=>{submitted.push(input);if(submitted.length===1)throw new Error('版本冲突');return {site};}},{initialLocalPath:'D:/site/index.html',sites:[site],onReloadSites:()=>reloads++});
  let tree=h.render();h.flush();choice(tree,'发布到').props.onChange(site.id);tree=h.render();button(tree,'检查页面').props.onClick();await settle();tree=h.render();
  button(tree,'更新托管').props.onClick();await settle();assert.equal(reloads,1);
  h.props.sitesLoading=true;tree=h.render();assert.equal(button(tree,'更新托管').props.disabled,true);
  button(tree,'更新托管').props.onClick();await settle();assert.equal(submitted.length,1);
  h.props.sitesLoading=false;h.props.sites=[{...site,contentToken:'new'}];tree=h.render();
  choice(tree,'发布到').props.onChange(site.id);tree=h.render();button(tree,'更新托管').props.onClick();await settle();
  assert.deepEqual(submitted.map(input=>input.expectedToken),['old','new']);
});

test('switching update targets preserves the new-page name draft',t=>{
  const site={id:'existing',name:'已有名称',entry:'index.html',contentToken:'token',enabled:true};
  const h=harness(t,{}, {initialLocalPath:'D:/site/index.html',sites:[site]});
  let tree=h.render();h.flush();input(tree,'页面名称').props.onChange({target:{value:'自定义名称'}});
  tree=h.render();choice(tree,'发布到').props.onChange(site.id);tree=h.render();
  assert.equal(input(tree,'页面名称'),undefined);
  choice(tree,'发布到').props.onChange('');tree=h.render();
  assert.equal(input(tree,'页面名称').props.value,'自定义名称');
});

test('a removed update target cannot silently turn into a new publication',async t=>{
  const site={id:'existing',name:'已有页面',entry:'index.html',contentToken:'token',enabled:true};
  const h=harness(t,{}, {initialLocalPath:'D:/site/index.html',sites:[site]});
  let tree=h.render();h.flush();choice(tree,'发布到').props.onChange(site.id);tree=h.render();
  button(tree,'检查页面').props.onClick();await settle();h.props.sites=[];tree=h.render();
  assert.equal(button(tree,'更新托管').props.disabled,true);
  button(tree,'更新托管').props.onClick();await settle();
  assert.equal(h.calls.some(call=>call[0]==='publish'),false);
});

for(const enabled of [true,false])test(`preview publication shows a direct link result (${enabled?'enabled':'disabled'})`,async t=>{
  const published={id:'created',publicId:'short-id',name:'结果页面',enabled};
  const h=harness(t,{publishHostedSite:async()=>({site:published})},{initialLocalPath:'D:/site/index.html'});
  let tree=h.render();h.flush();button(tree,'检查页面').props.onClick();await settle();tree=h.render();
  button(tree,'发布').props.onClick();await settle();tree=h.render();
  assert.equal(choice(tree,'发布到'),undefined);
  assert.equal(nodes(tree,node=>node.type==='input'&&node.props.readOnly)[0].props.value,'/p/short-id/');
  const open=nodes(tree,node=>node.type==='a'&&content(node)==='打开页面')[0];
  assert.equal(Boolean(open),enabled);if(open)assert.equal(open.props.href,'/p/short-id/');
  button(tree,'复制链接').props.onClick();await settle();tree=h.render();
  assert.ok(button(tree,'链接已复制'));assert.equal(h.calls.find(call=>call[0]==='copy')[1],'/p/short-id/');
  button(tree,'完成').props.onClick();assert.ok(h.calls.find(call=>call[0]==='close'));
  h.cleanup();assert.equal(h.calls.some(call=>call[0]==='cancel'),false);
});

test('copy failure preserves the published link and provides a retry',async t=>{
  const failure=new Error('剪贴板不可用');
  const h=harness(t,{publishHostedSite:async()=>({site:{id:'created',name:'页面',enabled:true}})},{initialLocalPath:'D:/site/index.html',copyError:failure});
  let tree=h.render();h.flush();button(tree,'检查页面').props.onClick();await settle();tree=h.render();button(tree,'发布').props.onClick();await settle();tree=h.render();
  button(tree,'复制链接').props.onClick();await settle();tree=h.render();
  assert.ok(button(tree,'复制链接'));assert.ok(nodes(tree,node=>node.props?.error===failure).length);
  assert.equal(nodes(tree,node=>node.type==='input'&&node.props.readOnly)[0].props.value,'/p/created/');
});

test('generation rules copy the full portable document and report success without publishing',async t=>{
  const h=harness(t,{listHostedSites:async()=>({sites:[]})},{authUser:{id:'admin',role:'admin'}});
  h.page();h.flush();await settle();
  button(h.page(),'复制 AI 生成规则').props.onClick();await settle();
  assert.equal(h.calls.find(call=>call[0]==='copy')[1],generationRules);
  assert.match(content(h.page()),/AI 生成规则已复制/);
  assert.equal(h.calls.some(call=>['upload','import','publish'].includes(call[0])),false);
});

test('preview request opens prefilled dialog and a new request replaces its seed',async t=>{
  const pageProps={importRequest:{path:'D:/site/one.html',requestId:1}};
  const h=harness(t,{listHostedSites:async()=>({sites:[]})},{authUser:{id:'admin',role:'admin'},pageProps});
  h.page();h.flush();await settle();
  let dialog=nodes(h.page(),node=>node.props?.initialLocalPath==='D:/site/one.html')[0];
  assert.equal(dialog.key,'1');
  pageProps.importRequest={path:'D:/site/two.html',requestId:2};
  h.page();h.flush();
  dialog=nodes(h.page(),node=>node.props?.initialLocalPath==='D:/site/two.html')[0];
  assert.equal(dialog.key,'2');
  assert.equal(h.calls.some(call=>['import','upload','publish'].includes(call[0])),false);
});

test('cancelling a preview addition closes its underlying hosting panel',async t=>{
  let closed=0;
  const h=harness(t,{listHostedSites:async()=>({sites:[]})},{authUser:{id:'admin',role:'admin'},pageProps:{onClose:()=>closed++,importRequest:{path:'D:/site/one.html',requestId:1}}});
  h.page();h.flush();await settle();
  nodes(h.page(),node=>typeof node.props?.onPublished==='function')[0].props.onClose();
  assert.equal(closed,1);
  assert.equal(nodes(h.page(),node=>typeof node.props?.onPublished==='function').length,0);
  assert.equal(h.calls.some(call=>['import','upload','publish'].includes(call[0])),false);
});

test('cancelling an addition from management preserves its hosting panel',async t=>{
  let closed=0;
  const h=harness(t,{listHostedSites:async()=>({sites:[]})},{authUser:{id:'admin',role:'admin'},pageProps:{onClose:()=>closed++}});
  h.page();h.flush();await settle();
  button(h.page(),'添加页面').props.onClick();
  nodes(h.page(),node=>typeof node.props?.onPublished==='function')[0].props.onClose();
  assert.equal(closed,0);
  assert.equal(nodes(h.page(),node=>typeof node.props?.onPublished==='function').length,0);
});

for(const fromPreview of [false,true])test(`publishing from ${fromPreview?'preview':'management'} preserves the correct containing window`,async t=>{
  let closed=0;
  const source=fromPreview?{kind:'local',path:'D:\\site\\one.html'}:{kind:'upload',filename:'原始  文件.zip'};
  const site={id:'new',publicId:'new-public',name:'新页面',entry:'index.html',fileCount:1,totalBytes:100,updatedAt:10,enabled:true,source};
  const h=harness(t,{listHostedSites:async()=>({sites:[]})},{authUser:{id:'admin',role:'admin'},pageProps:{onClose:()=>closed++,...(fromPreview?{importRequest:{path:'D:/site/one.html',requestId:1}}:{})}});
  h.page();h.flush();await settle();
  if(!fromPreview)button(h.page(),'添加页面').props.onClick();
  nodes(h.page(),node=>typeof node.props?.onPublished==='function')[0].props.onPublished(site);
  const tree=h.page();
  assert.equal(closed,0);
  assert.equal(nodes(tree,node=>typeof node.props?.onPublished==='function').length,fromPreview?1:0);
  if(fromPreview)assert.equal(tree.props.suspended,true);
  if(fromPreview)assert.doesNotMatch(content(tree),/页面已发布，可打开或复制访问链接/);
  else assert.match(content(tree),/页面已发布，可打开或复制访问链接/);
  assert.ok(button(tree,'复制链接'));
  assert.ok(button(tree,'更多'));
  const sourceLine=nodes(tree,node=>node.type==='bdi')[0];
  assert.equal(content(sourceLine),fromPreview?source.path:source.filename);
  assert.match(content(tree),fromPreview?/本地路径 · /:/上传文件 · /);
  assert.equal(nodes(tree,node=>node.type==='a'&&content(node)==='打开')[0].props.href,'/p/new-public/');
});

test('a late initial list cannot erase a newly published preview result',async t=>{
  let release,calls=0;
  const site={id:'new',name:'新页面',entry:'index.html',fileCount:1,totalBytes:100,updatedAt:10,enabled:true};
  const old={...site,id:'old',name:'已有页面',updatedAt:1};
  const h=harness(t,{listHostedSites:()=>++calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({sites:[site,old]})},{authUser:{id:'admin',role:'admin'},pageProps:{onClose(){},importRequest:{path:'D:/site/one.html',requestId:1}}});
  h.page();h.flush();
  nodes(h.page(),node=>typeof node.props?.onPublished==='function')[0].props.onPublished(site);
  assert.match(content(h.page()),/新页面/);
  release({sites:[old]});await settle();
  assert.match(content(h.page()),/新页面/);
  h.flush();await settle();
  assert.equal(calls,2);
  const tree=h.page();
  assert.match(content(tree),/新页面/);assert.match(content(tree),/已有页面/);
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
