import type { StorageCommandEnvelope } from '../storage/contracts.js';
import type { ObservedCommandResult } from '../storage/command-observation.js';
import type { AnalyticsFeatureProperties } from './registry.js';

type Meaning={feature:AnalyticsFeatureProperties['feature'];action:string;attributes?:Partial<AnalyticsFeatureProperties>;key?:string;sessionId?:string;decisionId?:string};
/** Explicit committed business boundaries, never arbitrary SQL/HTTP/status or serialized input. */
export function commandMeaning(request:StorageCommandEnvelope,result:ObservedCommandResult):Meaning|null{
  if(result.state!=='committed'&&result.state!=='rejected')return null;
  const input=request.command.input as Record<string,any>,value=result.value as any;
  const settings=(settingKey:AnalyticsFeatureProperties['settingKey']):Meaning=>({feature:'settings',action:'save',attributes:{settingKey}});
  switch(request.command.name){
    case 'project.create':return{feature:'project',action:'create'};
    case 'sidebar.move':return{feature:input.item.type==='project'?'project':'session',action:'reorder'};
    case 'project.update':{
      const c=input.changes,keys=Object.keys(c);
      return{feature:'project',action:keys.length>1?'update':c.name!==undefined?'rename':c.pinned!==undefined?c.pinned?'pin':'unpin':c.deletionProtected?'protect':'unprotect'};
    }
    case 'session.create':return{feature:'session',action:'create'};
    case 'session.update':return{feature:'session',action:Object.keys(input.changes).length>1?'update':input.changes.title!==undefined?'rename':input.changes.pinned!==undefined?input.changes.pinned?'pin':'unpin':'update'};
    case 'session.setPreferences':return{feature:'composer',action:'apply_model'};
    case 'project.setMember':return{feature:'project_members',action:'change_role'};
    case 'project.removeMember':return{feature:'project_members',action:'remove'};
    case 'share.create':return{feature:'share',action:'create'};
    case 'share.revoke':return{feature:'share',action:'revoke'};
    case 'share.delete':return{feature:'share',action:'delete'};
    case 'session.finishFork':return{feature:'session',action:'fork'};
    case 'session.finishUnarchive':return{feature:'session',action:'unarchive'};
    case 'trash.commitSoftDelete':return{feature:'trash',action:'delete'};
    case 'trash.commitPurge':return{feature:'trash',action:'delete_permanently'};
    case 'trash.restoreProject':case 'trash.restoreSession':return{feature:'trash',action:'restore'};
    case 'uploadCleanup.commit':return{feature:'project_uploads',action:'delete'};
    case 'account.setDisplayName':return settings('profile');
    case 'account.setAvatar':return settings('avatar');
    case 'account.setDefaultProject':return settings('default_project');
    case 'account.setDefaultEngine':return settings('default_engine');
    case 'account.setDefaultModel':return settings('default_model');
    case 'account.setNotifications':return settings('notification');
    case 'account.setPreviewPreferences':return settings('preview_capacity');
    case 'account.setTheme':return settings('theme');
    case 'concurrency.set':return settings('concurrency');
    case 'themeAsset.commit':return value?.kind?{feature:'settings',action:value.kind==='upload'?'upload_asset':'delete_asset'}:null;
    case 'account.setDisabled':return{feature:'account_admin',action:input.disabled?'disable':'enable'};
    case 'account.setProjectCreation':return{feature:'account_admin',action:'change_project_permission'};
    case 'approvalTrust.set':return{feature:'interaction',action:'save_trust'};
    case 'approvalTrust.clear':return{feature:'interaction',action:'clear_trust'};
    case 'workspace.linkSession':return{feature:'workbench',action:'link_session'};
    case 'workspace.unlinkSession':return{feature:'workbench',action:'unlink_session'};
    case 'repair.apply':return{feature:'maintenance',action:'apply_repair'};
    case 'hosting.save':return{feature:'hosting',action:input.expectedToken===null?'publish':'update'};
    case 'hosting.delete':return{feature:'hosting',action:'delete'};
    case 'account.changeTools':return input.action==='pin'?{feature:'tools',action:input.pinned?'pin':'unpin',attributes:{toolId:input.toolId}}:null;
    case 'turn.enqueue':return input.origin.kind==='direct'?{feature:'composer',action:'submit',key:`message:${input.messageId}`,attributes:{engine:input.engineId}}:null;
    case 'followup.submit':return{feature:'composer',action:'submit',key:`message:${input.messageId}`,attributes:{queued:true}};
    case 'queue.cancel':return value?.cancelled?{feature:'composer',action:'cancel_queued'}:null;
    // Acceptance of a stop request is not the terminal stopped outcome.
    case 'turn.requestStop':return null;
    case 'turn.projectTerminal':case 'turn.finishFromFact':case 'queue.finishUnstarted':{
      if(!value?.projected||!value.decision)return null;
      const d=value.decision;
      return{feature:'conversation',action:'run',key:d.id,sessionId:d.sessionId,decisionId:d.id,
        attributes:{engine:d.engineId,result:d.outcome==='completed'?'success':d.outcome==='stopped'?'cancelled':'error',
          ...(Number.isInteger(value.savedMessage?.durationMs)&&value.savedMessage.durationMs>=0&&value.savedMessage.durationMs<=86_400_000?{durationMs:value.savedMessage.durationMs}:{})}};
    }
    default:return null;
  }
}
