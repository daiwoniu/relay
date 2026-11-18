import { useEffect,useState } from 'react';
import { requestJson } from '../../api/client';

/** Keep the last result during same-account filters; never expose another account's data. */
export function useAnalyticsResource<T>(path:string|null,account:string,refresh:number){
  const key=JSON.stringify([account,path]);
  const [state,setState]=useState<{key:string;account:string;dataPath:string|null;data:T|null;loading:boolean;error:unknown;updatedAt:number|null}>({key:'',account:'',dataPath:null,data:null,loading:true,error:null,updatedAt:null});
  useEffect(()=>{
    if(!path)return;
    const controller=new AbortController();let active=true;
    setState(previous=>({key,account,dataPath:previous.account===account?previous.dataPath:null,data:previous.account===account?previous.data:null,updatedAt:previous.account===account?previous.updatedAt:null,loading:true,error:null}));
    void requestJson<T>(path,{signal:controller.signal,timeoutMs:10000})
      .then(data=>{if(active)setState({key,account,dataPath:path,data,loading:false,error:null,updatedAt:Date.now()});})
      .catch(error=>{if(active)setState(previous=>({...previous,loading:false,error}));});
    return()=>{active=false;controller.abort();};
  },[path,key,refresh]);
  const visible=path&&state.account===account?state:{key,account,dataPath:null,data:null,loading:Boolean(path),error:null,updatedAt:null};
  return{...visible,loading:state.key===key?visible.loading:Boolean(path),error:state.key===key?visible.error:null,stale:visible.data!==null&&visible.dataPath!==path};
}
