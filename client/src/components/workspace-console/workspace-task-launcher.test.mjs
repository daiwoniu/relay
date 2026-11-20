import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const compiled=await build({
  stdin:{contents:"export {useWorkspaceTaskLauncher} from './useWorkspaceTaskLauncher'; export {getChatDraftKey} from '../chat/chat-drafts'; export {getAttachmentDraftKey} from '../chat/attachment-drafts'; export {readWorkspaceTaskLaunch} from './workspace-task-launch';",resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'ts'},
  bundle:true,platform:'node',format:'cjs',write:false,
  plugins:[{name:'launcher-boundaries',setup(builder){
    builder.onResolve({filter:/stores\/chat$/},()=>({path:'store',namespace:'fixture'}));
    builder.onResolve({filter:/analytics\/features$/},()=>({path:'analytics',namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='store'
      ? 'export const useChatStore={getState:()=>fixture.state};'
      : 'export const featureAction=(...args)=>fixture.events.push(args);',loader:'js'}));
  }}],
});
const require=createRequire(import.meta.url);
function setup(){
  const values=new Map(),opened=[],locations=[];
  const tab={sessionStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},opener:{},location:{replace:url=>locations.push(url)},close(){this.closed=true;}};
  const fixture={state:{projects:[{id:'project',path:'D:/business'}]},events:[]};
  const window={location:{href:'https://relay.example/workspace?session=old#detail'},open:(...args)=>{opened.push(args);return tab;}};
  const module={exports:{}};
  new Function('require','module','exports','fixture','window',compiled.outputFiles[0].text)(require,module,module.exports,fixture,window);
  const api=module.exports,launcher=api.useWorkspaceTaskLauncher();
  return {api,launcher,fixture,window,tab,values,opened,locations,dashboard:{workspacePath:'d:/BUSINESS',workspaceId:'workspace',tasks:[],sessions:[]}};
}
const entries=[
  {kind:'local',key:'local',task:{id:'ledger',title:'本地任务',taskDocumentPath:'tasks/ledger/README.md'}},
  {kind:'subtask',key:'child',parent:{workItemId:'11',title:'父任务',url:'https://project.feishu.cn/p/story/detail/11'},subtask:{id:'22',title:'子任务'},localTasks:[]},
];

test('local and native creation share new-tab preparation and remove inherited prefill and drafts',()=>{
  for(const entry of entries){
    const f=setup(),draftKey=f.api.getChatDraftKey({sessionId:null,pendingProjectPath:null,currentProjectId:'project'});
    const attachmentKey=f.api.getAttachmentDraftKey(draftKey);
    for(const key of [draftKey,attachmentKey,'relay:workspace-prefill','relay:workspace-task-launch'])f.values.set(key,'stale');
    assert.equal(f.launcher.launchTaskEntry(entry,f.dashboard),null);
    assert.deepEqual(f.opened,[['about:blank','_blank']]);
    for(const key of [draftKey,attachmentKey,'relay:workspace-prefill'])assert.equal(f.values.has(key),false);
    const launch=f.api.readWorkspaceTaskLaunch(f.tab.sessionStorage,'project',Date.now());
    assert.equal(launch.workspaceId,'workspace');
    assert.equal(launch.taskId,entry.kind==='local'?'ledger':'feishu-subtask:11:22');
    assert.equal(f.tab.opener,null);
    const url=new URL(f.locations[0]);assert.equal(url.pathname,'/');assert.equal(url.searchParams.get('workspaceProject'),'project');assert.equal(url.searchParams.has('session'),false);assert.equal(url.hash,'');
    assert.equal(f.fixture.events.length,1);
  }
});

test('missing workspace, missing project and popup rejection return errors without navigating',()=>{
  const f=setup();
  assert.match(f.launcher.launchTaskEntry(entries[0],null),/尚未读取成功/);
  f.fixture.state.projects=[];
  assert.match(f.launcher.launchTaskEntry(entries[0],f.dashboard),/项目尚未登记/);
  assert.equal(f.opened.length,0);
  f.fixture.state.projects=[{id:'project',path:'D:/business'}];f.window.open=()=>null;
  assert.match(f.launcher.launchTaskEntry(entries[0],f.dashboard),/阻止了新标签页/);
  assert.equal(f.locations.length,0);
});

test('storage preparation failure closes the blank tab and reports failure',()=>{
  const f=setup();f.tab.sessionStorage.setItem=()=>{throw new Error('storage denied');};
  assert.match(f.launcher.launchTaskEntry(entries[1],f.dashboard),/无法在新标签页准备任务草稿/);
  assert.equal(f.tab.closed,true);assert.equal(f.locations.length,0);assert.equal(f.fixture.events.length,0);
});

test('opening a historical session only navigates and clears inherited task prefill',()=>{
  const f=setup();f.values.set('relay:workspace-prefill','stale');f.values.set('relay:workspace-task-launch','stale');
  assert.equal(f.launcher.continueSession('history'),null);
  assert.equal(f.values.size,0);
  const url=new URL(f.locations[0]);assert.equal(url.searchParams.get('session'),'history');assert.equal(url.searchParams.has('workspaceProject'),false);
});
