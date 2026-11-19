import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { tracker,type Page } from './tracker';
import { attachAnalyticsLifecycle } from './lifecycle';
export function analyticsPage(path:string,authenticated:boolean):Page{
  if(path==='/tools')return'tools';if(path==='/news')return'news';if(/^\/share(?:\/|$)/.test(path))return'public_share';
  if(!authenticated)return'login';
  return path==='/admin/analytics'?'analytics_admin':path==='/admin/news'?'news_admin':path==='/admin/page-hosting'?'page_hosting_admin':path==='/admin/task-workbench'?'task_workbench':path==='/'?'chat':'unknown';
}
export default function PageTracker(){
  const {pathname,key}=useLocation(),{status,user}=useAuth();
  useEffect(()=>{
    const publicPage=pathname==='/tools'||pathname==='/news'||/^\/share(?:\/|$)/.test(pathname);
    if(status==='loading'||status==='error'&&!publicPage)return;
    tracker.page(!publicPage&&user?.mustChangePassword?'password_change':analyticsPage(pathname,status==='authenticated'),key,user?.id??'guest');
  },[pathname,key,status,user?.id,user?.mustChangePassword]);
  useEffect(()=>attachAnalyticsLifecycle(tracker,window,document),[]);
  return null;
}
