import {featureAction,localAction,useFeatureView} from '../../analytics/features';
import { formatDateTime } from '../../utils/date-display.ts';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { HostedSite, HostingInspection } from '../../generated/relay-contracts';
import { useAuth } from '../../auth/AuthContext';
import { useChatStore } from '../../stores/chat';
import * as api from '../../api/page-hosting';
import { copyToClipboard } from '../../utils/clipboard';
import Modal from '../ui/Modal';
import PanelShell from '../ui/PanelShell';
import PageHostingIcon from '../icons/PageHostingIcon';
import ConfirmDialog from '../ui/ConfirmDialog';
import FailureNotice from '../ui/FailureNotice';
import HostingMoreMenu from './HostingMoreMenu';
import PreviewHostingDialog from './PreviewHostingDialog';
import generationRules from './generation-rules.md?raw';
import { getHostParentPath } from '../chat/host-file-path';
import './page-hosting.css';

const DirectoryPicker=lazy(()=>import('../chat/DirectoryPicker'));
const HostFilePicker=lazy(()=>import('../chat/HostFilePicker'));
const size=(bytes:number)=>bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
const nameFromPath=(value:string)=>value.replace(/[\\/]+$/,'').split(/[\\/]/).pop()?.replace(/\.(?:zip|html?)$/i,'')??'';

export function UploadDialog({site:existingSite,onClose,onPublished,initialLocalPath='',sites=[],sitesLoading=false,sitesError=null,onReloadSites=()=>{}}:{site:HostedSite|null;onClose:()=>void;onPublished:(site:HostedSite)=>void;initialLocalPath?:string;sites?:HostedSite[];sitesLoading?:boolean;sitesError?:unknown;onReloadSites?:()=>void}){
  const [previewTarget,setPreviewTarget]=useState<HostedSite|null>(null);
  const [publishedSite,setPublishedSite]=useState<HostedSite|null>(null);
  const site=initialLocalPath?previewTarget:existingSite;
  const {user}=useAuth();
  const directoryKey=`relay:page-hosting:last-directory:${user?.id??''}`;
  const lastDirectory=useRef('');
  const [pickerPath,setPickerPath]=useState('');
  const openPicker=(kind:'file'|'directory')=>{
    let saved=lastDirectory.current;
    try{saved=localStorage.getItem(directoryKey)||saved;}catch{}
    setPickerPath(saved);setPicker(kind);
  };
  const rememberDirectory=(directory:string)=>{lastDirectory.current=directory;try{localStorage.setItem(directoryKey,directory);}catch{}};
  const [source,setSource]=useState<'upload'|'local'>(initialLocalPath?'local':'upload');
  const [file,setFile]=useState<File|null>(null),[localPath,setLocalPath]=useState(initialLocalPath);
  const [name,setName]=useState(site?.name??nameFromPath(initialLocalPath)),[entry,setEntry]=useState('');
  const publishName=initialLocalPath&&site?site.name:name;
  const parentPath=getHostParentPath(initialLocalPath);
  const [stage,setStage]=useState<HostingInspection|null>(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0);
  const [error,setError]=useState<unknown>(null),[picker,setPicker]=useState<'file'|'directory'|null>(null);
  const controller=useRef<AbortController|null>(null),currentStage=useRef<HostingInspection|null>(null),mounted=useRef(true);
  currentStage.current=stage;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();const pending=currentStage.current;if(pending)void api.cancelHostedUpload(pending.uploadId).catch(()=>undefined);};},[]);
  const selectFile=(selected:File)=>{setFile(selected);setError(null);if(!name)setName(nameFromPath(selected.name));};
  const check=async()=>{
    if(busy)return;if(source==='upload'&&(!file||file.size>32*1024*1024)){setError(new Error('请选择不超过 32 MB 的 HTML 文件或 ZIP 包'));return;}
    if(source==='local'&&!localPath.trim()){setError(new Error('请选择服务器上的文件或目录'));return;}
    const report=localAction('hosting',source==='upload'?'upload':'import','admin');
    const abort=new AbortController();controller.current=abort;setBusy(true);setError(null);setProgress(0);
    try{
      const result=source==='upload'?await api.uploadHostedFile(file!,abort.signal,setProgress):await api.importHostedFiles(localPath.trim(),abort.signal);
      report(true);
      if(!mounted.current){void api.cancelHostedUpload(result.uploadId).catch(()=>undefined);return;}
      const preferred=source==='local'&&initialLocalPath?initialLocalPath.split(/[\\/]/).pop():undefined;
      currentStage.current=result;setStage(result);setEntry(preferred&&result.entries.includes(preferred)?preferred:site&&result.entries.includes(site.entry)?site.entry:result.suggestedEntry??'');
      if(!name.trim()&&!initialLocalPath)setName(nameFromPath(source==='upload'?file!.name:localPath));
    }catch(failure){report(abort.signal.aborted?'cancelled':'error');if(mounted.current)setError(failure);}finally{if(mounted.current)setBusy(false);}
  };
  const publish=async()=>{
    if(!stage||busy||(initialLocalPath&&site&&sitesLoading))return;setBusy(true);setError(null);
    if(initialLocalPath&&site&&!sites.some(item=>item.id===site.id)){setBusy(false);setError(new Error('所选托管页面已不可用，请重新选择'));return;}
    try{const result=await api.publishHostedSite({uploadId:stage.uploadId,name:publishName.trim(),entry,...(site?{siteId:site.id,expectedToken:site.contentToken}:{})});currentStage.current=null;if(mounted.current){if(initialLocalPath){setPublishedSite(result.site);setStage(null);}onPublished(result.site);}}
    catch(failure){if(mounted.current){setError(failure);if(initialLocalPath&&site)onReloadSites();}}finally{if(mounted.current)setBusy(false);}
  };
  const reset=async()=>{if(!stage||busy)return false;setBusy(true);setError(null);try{await api.cancelHostedUpload(stage.uploadId);currentStage.current=null;setStage(null);return true;}catch(failure){setError(failure);return false;}finally{setBusy(false);}};
  if(initialLocalPath)return <PreviewHostingDialog filePath={initialLocalPath} includeResources={localPath===parentPath} canIncludeResources={Boolean(parentPath)} onResourcesChange={include=>{void (async()=>{if(stage&&!await reset())return;setLocalPath(include?parentPath!:initialLocalPath);setError(null);})();}} sites={sites} sitesLoading={sitesLoading} sitesError={sitesError} onReloadSites={onReloadSites} site={site} onTargetChange={id=>{
    const target=id?sites.find(item=>item.id===id):null;
    if(id&&!target){setError(new Error('该托管页面已不可用，请重新选择'));return;}
    setPreviewTarget(target??null);setError(null);
  }} name={publishName} onNameChange={setName} stage={stage} entry={entry} onEntryChange={value=>{featureAction('hosting','select_entry','admin');setEntry(value);}} busy={busy} error={error} onCheck={()=>void check()} onPublish={()=>void publish()} onClose={onClose} publishedSite={publishedSite}/>;
  return <>
    <Modal open onClose={()=>{if(!busy)onClose();}} suspended={picker!==null} closeOnBackdrop={!busy} closeOnEscape={!busy} labelledBy="hosting-upload-title" contentClassName="hosting-dialog">
      <header className="hosting-dialog-header"><h2 id="hosting-upload-title">{site?'更新页面':'添加托管页面'}</h2><button type="button" onClick={onClose} disabled={busy} aria-label="关闭">×</button></header>
      <div className="hosting-dialog-body">
        <p className="hosting-muted">发布后任何人持链接均可访问页面及其资源，请确认内容适合公开。</p>
        {!stage&&<>
          <div className="hosting-source" role="group" aria-label="内容来源"><button type="button" aria-pressed={source==='upload'} disabled={busy} onClick={()=>{setSource('upload');setError(null);}}>上传文件</button><button type="button" aria-pressed={source==='local'} disabled={busy} onClick={()=>{setSource('local');setError(null);}}>从本机导入</button></div>
          {source==='upload'?<label className="hosting-drop" onDragOver={event=>{event.preventDefault();}} onDrop={event=>{event.preventDefault();if(!busy&&event.dataTransfer.files[0])selectFile(event.dataTransfer.files[0]);}}>
            <strong>{file?file.name:'选择或拖入 HTML 文件 / ZIP 包'}</strong><span>单文件最大 32 MB · ZIP 解压后最大 128 MB / 1500 个文件</span>
            <input type="file" accept=".html,.htm,.zip" disabled={busy} onChange={event=>{if(event.target.files?.[0])selectFile(event.target.files[0]);}} />
          </label>:<div className="hosting-local">
            <p className="hosting-muted">选择 Relay 服务器所在电脑上的 HTML 文件、ZIP 包或静态目录。后台直接复制，不经过浏览器传输。</p>
            <label>文件或目录路径<input value={localPath} disabled={busy} onChange={event=>setLocalPath(event.target.value)} placeholder="服务器上的绝对路径" /></label>
            <div className="hosting-actions"><button type="button" disabled={busy} onClick={()=>openPicker('file')}>选择文件 / ZIP</button><button type="button" disabled={busy} onClick={()=>openPicker('directory')}>选择目录</button></div>
          </div>}
        </>}
        <label className="hosting-field">页面名称<input value={name} maxLength={80} disabled={busy} onChange={event=>setName(event.target.value)} placeholder="例如：产品介绍" /></label>
        {stage&&<>
          <div className="hosting-summary" role="status">共 {stage.fileCount} 个文件 · {size(stage.totalBytes)} · 已修正 {stage.rewritten} 处路径{stage.warningCount>0&&` · ${stage.warningCount} 项提示`}</div>
          <label className="hosting-field">首页<select value={entry} disabled={busy} onChange={event=>{featureAction('hosting','select_entry','admin');setEntry(event.target.value);}}><option value="" disabled>请选择 HTML 首页</option>{stage.entries.map(path=><option key={path} value={path}>{path}</option>)}</select></label>
          {stage.warningCount>0&&<details className="hosting-checks"><summary>查看检查提示</summary><ul>{stage.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>{stage.warningCount>stage.warnings.length&&<p>仅展示前 {stage.warnings.length} 项，请预览确认页面效果。</p>}<p>无法定位的引用保持原样，动态脚本路径不会自动修改。</p></details>}
          <p className="hosting-muted">临时内容保留 1 小时。{site?'替换后访问链接不变，只保留最新内容。':'发布后可随时更新、停用或删除。'}</p>
        </>}
        {busy&&<div role="status" className="hosting-muted">{stage?'正在发布…':source==='local'?'正在复制并检查…':progress===100?'上传完成，正在解压检查…':`正在上传 ${progress}%`}{!stage&&source==='upload'&&<progress max={100} value={progress} />}</div>}
        {error!==null&&<FailureNotice error={error} />}
      </div>
      <footer className="hosting-dialog-footer"><button type="button" disabled={busy} onClick={onClose}>取消</button>{stage?<><button type="button" disabled={busy} onClick={()=>void reset()}>重新选择</button>{entry&&<a className="hosting-button" href={api.hostedPreviewUrl(stage,entry)} target="_blank" rel="noopener noreferrer" onClick={()=>featureAction('hosting','preview','admin')}>预览</a>}<button type="button" className="hosting-primary" disabled={busy||!entry||!name.trim()} onClick={()=>void publish()}>{site?'替换并发布':'发布'}</button></>:<button type="button" className="hosting-primary" disabled={busy||(source==='upload'?!file:!localPath.trim())} onClick={()=>void check()}>{source==='upload'?'上传并检查':'导入并检查'}</button>}</footer>
    </Modal>
    {picker&&<Suspense fallback={<span role="status">正在加载文件选择器…</span>}>{picker==='directory'?<DirectoryPicker initialPath={pickerPath} onCancel={()=>setPicker(null)} onSelect={path=>{rememberDirectory(path);setLocalPath(path);if(!name)setName(nameFromPath(path));setPicker(null);}}/>:<HostFilePicker initialPath={pickerPath} remainingSlots={1} existingHostFilePaths={[]} onCancel={()=>setPicker(null)} onSelect={files=>{const path=files[0]?.path;if(path){rememberDirectory(getHostParentPath(path)??'');setLocalPath(path);if(!name)setName(nameFromPath(path));}setPicker(null);}}/>}</Suspense>}
  </>;
}

export default function PageHostingPage({onClose,mobile=false,importRequest}:{onClose?:()=>void;mobile?:boolean;importRequest?:{path:string;requestId:number}|null}={}){useFeatureView('hosting',true,'user_menu');
  const {user}=useAuth(),toggleSidebar=useChatStore(state=>state.toggleSidebar);
  const [sites,setSites]=useState<HostedSite[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState<unknown>(null),[message,setMessage]=useState('');
  const [upload,setUpload]=useState<{site:HostedSite|null;initialLocalPath?:string;requestId?:number}|null>(()=>importRequest&&user?.role==='admin'?{site:null,initialLocalPath:importRequest.path,requestId:importRequest.requestId}:null),[remove,setRemove]=useState<HostedSite|null>(null),[rename,setRename]=useState<HostedSite|null>(null),[newName,setNewName]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(importRequest&&user?.role==='admin')setUpload({site:null,initialLocalPath:importRequest.path,requestId:importRequest.requestId});},[importRequest,user?.role]);
  const [reload,setReload]=useState(0);
  const [rulesError,setRulesError]=useState<unknown>(null);
  const [more,setMore]=useState<{site:HostedSite;anchor:HTMLButtonElement}|null>(null);
  const sitesRevision=useRef(0);
  useEffect(()=>{if(user?.role!=='admin')return;const abort=new AbortController(),revision=sitesRevision.current;setLoading(true);setError(null);void api.listHostedSites(abort.signal).then(result=>{
    if(abort.signal.aborted)return;
    if(revision!==sitesRevision.current){setReload(value=>value+1);return;}
    setSites(result.sites);
  }).catch(failure=>{if(!abort.signal.aborted)setError(failure);}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();},[reload,user?.id,user?.role]);
  const upsert=(site:HostedSite)=>{sitesRevision.current++;setSites(current=>[site,...current.filter(item=>item.id!==site.id)].sort((a,b)=>b.updatedAt-a.updatedAt));};
  const handlePublished=(site:HostedSite)=>{
    upsert(site);
    if(upload?.initialLocalPath)return;
    setUpload(null);setMessage(site.enabled?'页面已发布，可打开或复制访问链接。':'内容已更新，站点仍为停用状态。');
  };
  const patch=async(site:HostedSite,changes:{name?:string;enabled?:boolean})=>{setBusy(true);setError(null);setMessage('');try{const result=await api.patchHostedSite(site,changes);upsert(result.site);setRename(null);}catch(failure){setError(failure);}finally{setBusy(false);}};
  const copy=async(site:HostedSite)=>{const report=localAction('hosting','copy_link','admin');try{await copyToClipboard(new URL(api.hostedUrl(site.publicId??site.id),window.location.origin).href);report(true);setMessage('访问链接已复制');}catch(failure){report(false);setError(failure);}};
  const copyRules=async()=>{setMessage('');setRulesError(null);try{await copyToClipboard(generationRules);setMessage('AI 生成规则已复制，可直接粘贴给其他 AI 或会话。');}catch(failure){setRulesError(failure);}};
  if(user?.role!=='admin')return <div className="hosting-page"><p>仅管理员可管理页面托管。</p></div>;
  const content=<section className="hosting-page">
    <header className="hosting-page-header">{!onClose&&<button type="button" className="hosting-sidebar-toggle lg:hidden" onClick={toggleSidebar} aria-label="打开侧栏">☰</button>}<div>{onClose?<p className="hosting-muted">共 {sites.length} 个托管页面</p>:<><h1><PageHostingIcon size={20} />页面托管 <span>{sites.length}</span></h1><p className="hosting-muted">上传或从服务器本机导入，生成可直接访问的公开链接。</p></>}</div><div className="hosting-actions hosting-header-actions"><button type="button" onClick={()=>void copyRules()}>复制 AI 生成规则</button><button type="button" className="hosting-primary" disabled={loading||busy} onClick={()=>{setMessage('');setUpload({site:null});}}>添加页面</button></div></header>
    <div className="hosting-page-body">
      {rulesError!==null&&<div className="hosting-summary" role="alert"><FailureNotice error={rulesError} description="AI 生成规则复制失败" suggestion="请允许浏览器访问剪贴板，并再次点击「复制 AI 生成规则」。" /></div>}
      {message&&<p role="status" className="hosting-summary">{message}</p>}{error!==null&&<div className="hosting-summary"><FailureNotice error={error} /><button type="button" onClick={()=>setReload(value=>value+1)}>刷新列表</button></div>}
      {loading&&!sites.length?<p role="status">正在加载托管页面…</p>:!sites.length?<div className="hosting-empty"><h2>还没有托管页面</h2><p className="hosting-muted">支持单个 HTML、ZIP 包，或直接复制服务器上的静态目录。</p><button className="hosting-primary" type="button" onClick={()=>setUpload({site:null})}>添加第一个页面</button></div>:<ul className="hosting-sites">{sites.map(site=><li key={site.id} className="hosting-site">
        <div className="hosting-site-info"><h2>{site.name}<span className={site.enabled?'hosting-status':'hosting-status is-disabled'}>{site.enabled?'已发布':'已停用'}</span></h2><p className="hosting-muted">{site.entry} · {size(site.totalBytes)} · {site.fileCount} 个文件</p><p className="hosting-muted">更新于 {formatDateTime(site.updatedAt, { seconds: true })}</p></div>
        <div className="hosting-actions"><a className="hosting-button" href={api.hostedUrl(site.publicId??site.id)} target="_blank" rel="noopener noreferrer" onClick={()=>{const report=localAction('hosting','open_external','admin');report(true);}}>打开</a><button type="button" onClick={()=>void copy(site)}>复制链接</button><button type="button" disabled={busy} aria-haspopup="menu" aria-expanded={more?.site.id===site.id} aria-label={`${site.name}的更多操作`} onClick={event=>setMore(more?.site.id===site.id?null:{site,anchor:event.currentTarget})}>更多</button></div>
      </li>)}</ul>}
    </div>
    {more&&<HostingMoreMenu site={more.site} anchor={more.anchor} onClose={()=>setMore(null)} onAction={action=>{const site=more.site;setMore(null);if(action==='update')setUpload({site});else if(action==='rename'){setRename(site);setNewName(site.name);}else if(action==='toggle')void patch(site,{enabled:!site.enabled});else setRemove(site);}}/>}
    {upload&&<UploadDialog key={upload.requestId??upload.site?.id??'new'} site={upload.site} initialLocalPath={upload.initialLocalPath} sites={sites} sitesLoading={loading} sitesError={error} onReloadSites={()=>setReload(value=>value+1)} onClose={()=>{setUpload(null);if(upload.initialLocalPath)onClose?.();}} onPublished={handlePublished}/>}
    <Modal open={rename!==null} onClose={()=>{if(!busy)setRename(null);}} labelledBy="hosting-rename-title" contentClassName="hosting-dialog"><form onSubmit={event=>{event.preventDefault();if(rename&&newName.trim()&&!busy)void patch(rename,{name:newName.trim()});}}><header className="hosting-dialog-header"><h2 id="hosting-rename-title">重命名页面</h2></header><div className="hosting-dialog-body"><label className="hosting-field">页面名称<input data-autofocus value={newName} maxLength={80} disabled={busy} onChange={event=>setNewName(event.target.value)} /></label><p className="hosting-muted">访问链接保持不变。</p>{error!==null&&<FailureNotice error={error}/>}</div><footer className="hosting-dialog-footer"><button type="button" disabled={busy} onClick={()=>setRename(null)}>取消</button><button className="hosting-primary" disabled={busy||!newName.trim()} type="submit">保存</button></footer></form></Modal>
    <ConfirmDialog open={remove!==null} title="删除托管页面" description="删除后托管文件会被移除，现有访问链接立即失效，无法恢复。" subject={remove?{label:'页面',value:remove.name}:undefined} tone="danger" confirmLabel="删除" onCancel={()=>{featureAction('hosting','cancel','admin');setRemove(null);}} onConfirm={async()=>{if(!remove)return;await api.deleteHostedSite(remove);sitesRevision.current++;setSites(current=>current.filter(site=>site.id!==remove.id));setRemove(null);}} />
  </section>;
  return onClose?<PanelShell open onClose={onClose} title="页面托管" icon={<PageHostingIcon />} description="上传或从服务器本机导入，生成公开访问链接" titleId="page-hosting-title" size="content" mobile={mobile} closeOnEscape={more===null} suspended={upload!==null||rename!==null||remove!==null}>{content}</PanelShell>:content;
}
