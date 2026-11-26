import { useEffect,useRef,useState } from 'react';
import { requestJson } from '../../api/client';

/** Keep the last result during same-account filters; never expose another account's data. */
export function useAnalyticsResource<T>(path:string|null,account:string,refresh:number){
  const [attempt,setAttempt]=useState(0);
  const key=JSON.stringify([account,path]);
  const requestScope=useRef({key,refresh,attempt,fresh:false});
  const [state,setState]=useState<{key:string;account:string;dataPath:string|null;data:T|null;loading:boolean;error:unknown;updatedAt:number|null;cached:boolean}>({key:'',account:'',dataPath:null,data:null,loading:true,error:null,updatedAt:null,cached:false});
  useEffect(()=>{
    const previous=requestScope.current;
    if(previous.refresh!==refresh||previous.attempt!==attempt||previous.key!==key){
      requestScope.current={key,refresh,attempt,fresh:previous.refresh!==refresh||previous.attempt!==attempt};
    }
    if(!path)return;
    const controller=new AbortController();let active=true;
    setState(previous=>({...previous,key,account,dataPath:previous.account===account?previous.dataPath:null,data:previous.account===account?previous.data:null,updatedAt:previous.account===account?previous.updatedAt:null,loading:true,error:null}));
    const target=`${path}${path.includes('?')?'&':'?'}meta=true${requestScope.current.fresh?'&fresh=true':''}`;
    void requestJson<{data:T;asOf:number;cached:boolean}|T>(target,{signal:controller.signal,timeoutMs:10000})
      .then(response=>{const wrapped=response&&typeof response==='object'&&'asOf'in response&&'data'in response?response as {data:T;asOf:number;cached:boolean}:null;
        if(active)setState({key,account,dataPath:path,data:wrapped?wrapped.data:response as T,loading:false,error:null,updatedAt:wrapped?.asOf??Date.now(),cached:wrapped?.cached??false});})
      .catch(error=>{if(active)setState(previous=>({...previous,loading:false,error}));});
    return()=>{active=false;controller.abort();};
  },[path,key,refresh,attempt]);
  const visible=path&&state.account===account?state:{key,account,dataPath:null,data:null,loading:Boolean(path),error:null,updatedAt:null};
  return{...visible,loading:state.key===key?visible.loading:Boolean(path),error:state.key===key?visible.error:null,stale:visible.data!==null&&visible.dataPath!==path,retry:()=>setAttempt(value=>value+1)};
}
