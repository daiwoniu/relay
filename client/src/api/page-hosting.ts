import type { HostedSite, HostingInspection } from '../generated/relay-contracts';
import { ApiError, AUTH_REQUIRED_EVENT, parseApiErrorDto, requestJson, jsonBody } from './client';

const base='/api/admin/page-hosting';
export const listHostedSites=(signal?:AbortSignal)=>requestJson<{sites:HostedSite[]}>(base,{signal});
export const importHostedFiles=(path:string,signal?:AbortSignal)=>requestJson<HostingInspection>(`${base}/imports`,{method:'POST',...jsonBody({path}),signal,timeoutMs:180_000});
export const cancelHostedUpload=(id:string)=>requestJson(`${base}/uploads/${id}`,{method:'DELETE'});
export const publishHostedSite=(input:{uploadId:string;name:string;entry:string;siteId?:string;expectedToken?:string})=>requestJson<{site:HostedSite}>(`${base}/publish`,{method:'POST',...jsonBody(input),timeoutMs:60_000});
export const patchHostedSite=(site:HostedSite,changes:{name?:string;enabled?:boolean})=>requestJson<{site:HostedSite}>(`${base}/${site.id}`,{method:'PATCH',...jsonBody(changes),headers:{'Content-Type':'application/json','If-Match':site.contentToken}});
export const deleteHostedSite=(site:HostedSite)=>requestJson(`${base}/${site.id}`,{method:'DELETE',headers:{'If-Match':site.contentToken}});
export const hostedUrl=(id:string)=>`/p/${id}/`;
export const hostedPreviewUrl=(stage:HostingInspection,entry:string)=>`/p-preview/${stage.uploadId}/${stage.previewToken}/${entry.split('/').map(encodeURIComponent).join('/')}`;

export function uploadHostedFile(file:File,signal:AbortSignal,onProgress:(percent:number)=>void):Promise<HostingInspection>{
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST',`${base}/uploads`);xhr.withCredentials=true;xhr.timeout=180_000;
    xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-File-Name',encodeURIComponent(file.name));
    const abort=()=>xhr.abort();signal.addEventListener('abort',abort,{once:true});
    const cleanup=()=>signal.removeEventListener('abort',abort);
    xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(Math.min(100,Math.round(event.loaded/event.total*100)));};
    xhr.onerror=()=>{cleanup();reject(new ApiError(0,null,'无法连接 Relay'));};
    xhr.ontimeout=()=>{cleanup();reject(new Error('文件处理超时，请稍后重试'));};
    xhr.onabort=()=>{cleanup();reject(new DOMException('已取消','AbortError'));};
    xhr.onload=()=>{
      cleanup();let payload:unknown;try{payload=JSON.parse(xhr.responseText);}catch{reject(new Error('服务器返回无效结果'));return;}
      if(xhr.status===401)window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
      if(xhr.status<200||xhr.status>=300){reject(new ApiError(xhr.status,parseApiErrorDto(payload)));return;}
      resolve(payload as HostingInspection);
    };
    if(signal.aborted){cleanup();reject(new DOMException('已取消','AbortError'));return;}xhr.send(file);
  });
}
