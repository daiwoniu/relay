export const CODEX_LIFECYCLE_CHANNEL='relay-codex-lifecycle-v1' as const;
export type CodexLifecycleMessage={channel:typeof CODEX_LIFECYCLE_CHANNEL;type:'activity_started'|'idle'};
export interface EnsureCodexProcessReadyOptions{send?:(message:CodexLifecycleMessage)=>void;isReady?:()=>Promise<boolean>;timeoutMs?:number;intervalMs?:number}
async function defaultCodexReady(){
  const{resolveCodexEndpoint}=await import('../codex/endpoint.js');
  try{return(await fetch(resolveCodexEndpoint().readyUrl,{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}
}
/** Process readiness only; it has no repository, snapshot cache or idle-release default. */
export async function ensureCodexProcessReady(options:EnsureCodexProcessReadyOptions={}){
  const isReady=options.isReady??defaultCodexReady;if(await isReady())return false;
  const send=options.send??((message:CodexLifecycleMessage)=>{
    if(!process.send)throw new Error('Codex app-server 已停止，且当前后端未连接 Relay 启动器');process.send(message);
  });
  send({channel:CODEX_LIFECYCLE_CHANNEL,type:'activity_started'});
  const deadline=Date.now()+(options.timeoutMs??10000),intervalMs=options.intervalMs??100;
  do{if(intervalMs>0)await new Promise(resolve=>setTimeout(resolve,intervalMs));if(await isReady())return true;}while(Date.now()<deadline);
  throw new Error('Codex app-server 按需启动超时');
}
