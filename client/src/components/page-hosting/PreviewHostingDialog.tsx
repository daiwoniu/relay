import type { HostedSite, HostingInspection } from '../../generated/relay-contracts';
import Modal from '../ui/Modal';
import FailureNotice from '../ui/FailureNotice';
import PageHostingIcon from '../icons/PageHostingIcon';
import { hostedPreviewUrl, hostedUrl } from '../../api/page-hosting';
import { featureAction, localAction } from '../../analytics/features';
import { useState } from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import HostingSelect from './HostingSelect';
import { MenuIcon } from '../icons/MenuIcon';

interface Props {
  filePath: string;
  includeResources: boolean;
  canIncludeResources: boolean;
  onResourcesChange: (include: boolean) => void;
  sites: HostedSite[];
  sitesLoading: boolean;
  sitesError: unknown;
  onReloadSites: () => void;
  site: HostedSite | null;
  onTargetChange: (id: string) => void;
  name: string;
  onNameChange: (name: string) => void;
  stage: HostingInspection | null;
  entry: string;
  onEntryChange: (entry: string) => void;
  busy: boolean;
  error: unknown;
  onCheck: () => void;
  onPublish: () => void;
  onClose: () => void;
  publishedSite: HostedSite | null;
}

export default function PreviewHostingDialog(props: Props) {
  const { site, stage, busy, entry } = props;
  const [copyStatus,setCopyStatus]=useState<'idle'|'busy'|'copied'>('idle');
  const [copyError,setCopyError]=useState<unknown>(null);
  const fileName=props.filePath.split(/[\\/]/).pop()??'';
  const unavailable=Boolean(site&&!props.sitesLoading&&!props.sites.some(item=>item.id===site.id));
  if(props.publishedSite){
    const published=props.publishedSite;
    const relativeUrl=hostedUrl(published.publicId??published.id);
    const url=typeof window==='undefined'?relativeUrl:new URL(relativeUrl,window.location.origin).href;
    const copy=async()=>{if(copyStatus==='busy')return;const report=localAction('hosting','copy_link','admin');setCopyStatus('busy');setCopyError(null);try{await copyToClipboard(url);report(true);setCopyStatus('copied');}catch(failure){report(false);setCopyStatus('idle');setCopyError(failure);}};
    return <Modal open onClose={props.onClose} labelledBy="preview-hosting-result-title" contentClassName="hosting-dialog">
      <header className="hosting-dialog-header"><h2 id="preview-hosting-result-title" className="flex items-center gap-2"><PageHostingIcon />{site?'托管已更新':'发布成功'}</h2><button type="button" onClick={props.onClose} aria-label="关闭">×</button></header>
      <div className="hosting-dialog-body hosting-publish-result">
        <span className="hosting-result-mark" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="m5 12 4 4 10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span>
        <h3>{published.name}</h3>
        <p role="status" className="hosting-muted">{published.enabled?'链接已准备好，可以直接打开或复制。':'内容已更新；此页面仍处于停用状态，启用后链接才可访问。'}</p>
        <label className="hosting-field">访问链接<input readOnly value={url} onFocus={event=>event.currentTarget.select()} /></label>
        {copyError!=null&&<FailureNotice error={copyError} description="复制链接失败，可选中上方链接手动复制" />}
      </div>
      <footer className="hosting-dialog-footer"><button type="button" onClick={props.onClose}>完成</button>{published.enabled?<a className="hosting-button" href={url} target="_blank" rel="noopener noreferrer" onClick={()=>featureAction('hosting','open_external','admin')}>打开页面</a>:<button type="button" disabled>页面已停用</button>}<button autoFocus type="button" className="hosting-primary" disabled={copyStatus==='busy'} onClick={()=>void copy()}>{copyStatus==='copied'?'链接已复制':copyStatus==='busy'?'正在复制…':'复制链接'}</button></footer>
    </Modal>;
  }
  return <Modal open onClose={() => { if (!busy) props.onClose(); }} closeOnBackdrop={!busy} closeOnEscape={!busy} labelledBy="preview-hosting-title" contentClassName="hosting-dialog">
    <header className="hosting-dialog-header"><h2 id="preview-hosting-title" className="flex items-center gap-2"><PageHostingIcon />托管当前页面</h2><button type="button" onClick={props.onClose} disabled={busy} aria-label="关闭">×</button></header>
    <div className="hosting-dialog-body">
      <div className="hosting-preview-file"><strong>{fileName}</strong><p className="hosting-muted">{props.filePath}</p></div>
      {props.canIncludeResources && <div>
        <label className="hosting-preview-resources"><input type="checkbox" checked={props.includeResources} disabled={busy} onChange={event => props.onResourcesChange(event.target.checked)} />包含同目录资源</label>
        <p className="hosting-muted">{props.includeResources ? '将导入所在目录的静态文件，请确认没有无关内容。' : '页面引用本地图片、CSS 或脚本时勾选。'}</p>
      </div>}
      <HostingSelect label="发布到" value={site?.id??''} disabled={busy||props.sitesLoading} onChange={props.onTargetChange} options={[
        {value:'',label:'新增托管页面',description:'生成一个新的访问链接',icon:<MenuIcon type="plus" size={18}/>},
        ...props.sites.map(item=>({value:item.id,label:item.name,description:`更新已有托管 · ${item.entry}${item.enabled?'':' · 已停用'}`,icon:<PageHostingIcon/>})),
        ...(unavailable&&site?[{value:site.id,label:site.name,description:'已不可用，请重新选择',disabled:true,icon:<PageHostingIcon/>}]:[]),
      ]}/>
      {props.sitesLoading && <p className="hosting-muted" role="status">正在读取已有托管页面…</p>}
      {props.sitesError != null && <div><FailureNotice error={props.sitesError} description="已有托管页面读取失败" /><button type="button" className="hosting-button" disabled={busy || props.sitesLoading} onClick={props.onReloadSites}>重试读取</button></div>}
      {site ? <p className="hosting-muted">将替换“{site.name}”的页面内容，访问链接不变。{!site.enabled && '更新后仍保持停用。'}</p> : <label className="hosting-field">页面名称<input value={props.name} maxLength={80} disabled={busy} placeholder="页面名称" onChange={event => props.onNameChange(event.target.value)} /></label>}
      <p className="hosting-muted">启用的托管页面可由持链接的人访问。</p>
      {unavailable&&<p role="alert" className="hosting-muted">所选托管页面已不可用，请重新选择发布目标。</p>}
      {stage && <>
        <p className="hosting-summary" role="status">检查完成 · {stage.fileCount} 个文件{stage.warningCount > 0 && ` · ${stage.warningCount} 项提示`}</p>
        {(stage.entries.length > 1 && !stage.entries.includes(fileName)) || !entry ? <HostingSelect label="打开的页面" value={entry} disabled={busy} placeholder="请选择页面" onChange={props.onEntryChange} options={stage.entries.map(path=>({value:path,label:path,icon:<PageHostingIcon/>}))}/> : null}
        {stage.warningCount > 0 && <details className="hosting-checks"><summary>查看检查提示</summary><ul>{stage.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>{stage.warningCount > stage.warnings.length && <p>仅展示前 {stage.warnings.length} 项，请预览确认页面效果。</p>}</details>}
      </>}
      {busy && <p className="hosting-muted" role="status">{stage ? '正在处理…' : '正在检查页面…'}</p>}
      {props.error != null && <FailureNotice error={props.error} suggestion={site?'如页面已在其他位置发生变化，请重新选择发布目标后重试。':undefined} />}
    </div>
    <footer className="hosting-dialog-footer">
      <button type="button" disabled={busy} onClick={props.onClose}>取消</button>
      {stage ? <>
        {entry && <a className="hosting-button" href={hostedPreviewUrl(stage, entry)} target="_blank" rel="noopener noreferrer" onClick={()=>featureAction('hosting','preview','admin')}>预览</a>}
        <button type="button" className="hosting-primary" disabled={busy || unavailable || Boolean(site&&props.sitesLoading) || !entry || !props.name.trim()} onClick={props.onPublish}>{site ? '更新托管' : '发布'}</button>
      </> : <button type="button" className="hosting-primary" disabled={busy || !props.name.trim()} onClick={props.onCheck}>检查页面</button>}
    </footer>
  </Modal>;
}
