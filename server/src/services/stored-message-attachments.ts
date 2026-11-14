import { SendAttachmentDtoSchema,MessageAttachmentDtoSchema,type SendAttachmentDto,type MessageAttachmentDto } from '../contracts/index.js';
import type { CoreStoragePort,StoragePrincipal,QueueClaim,StoredClaimedTurn,UploadReadScope } from '../storage/contracts.js';
import { parseStoragePrincipal,canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import { ProjectFileActivities } from '../uploads/project-file-activities.js';
import { UploadPromoter } from '../uploads/upload-promoter.js';
import type { FileAccessGrants } from '../file-access.js';
import fs from 'node:fs/promises';
type Actor=Extract<StoragePrincipal,{kind:'user'}>;
export class StoredMessageAttachments{
  private closed=false;
  constructor(private readonly options:{port:CoreStoragePort;files:ProjectFileActivities;promoter:Pick<UploadPromoter,'run'|'inspect'>;grants:Pick<FileAccessGrants,'allows'|'revoke'>;assertExclusiveWriter:()=>Promise<void>}){}
  async prepare(rawActor:Actor,projectId:string,messageId:string,raw:SendAttachmentDto[],signal?:AbortSignal):Promise<MessageAttachmentDto[]>{
    const actor=parseStoragePrincipal(rawActor);if(actor.kind!=='user')throw new StorageContractError('FORBIDDEN');
    const drafts=SendAttachmentDtoSchema.array().max(10).parse(JSON.parse(canonicalJson(raw,512*1024)));
    if(!drafts.length)return[];
    const hosts=drafts.filter(draft=>draft.kind==='host_file'),uploads=drafts.filter(draft=>draft.kind==='uploaded_file');
    const active=()=>{if(this.closed||signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');
      if(hosts.some(host=>!this.options.grants.allows(host.path,host.accessToken,actor.userId)))throw new StorageContractError('FORBIDDEN');};
    try{
      active();const scope=await this.options.port.readUploadScope({principal:actor,projectId}),physicalRoot=await fs.realpath(scope.projectPath);
      const guard=async()=>{active();await this.options.assertExclusiveWriter();const current=await this.options.port.readUploadScope({principal:actor,projectId});
        if(current.projectPath!==scope.projectPath||current.ownerUserId!==scope.ownerUserId||current.viewerUserId!==actor.userId||await fs.realpath(scope.projectPath)!==physicalRoot)throw new StorageContractError('CONFLICT');active();};
      return await this.options.files.withMutation(scope,guard,async ownedSignal=>{
        const result=await this.options.promoter.run({projectPath:physicalRoot,projectId,userId:actor.userId,messageId,uploads,
          hosts:hosts.map(({accessToken:_,...host})=>host)},async()=>{await guard();return true;},ownedSignal);
        await guard();for(const host of result.hosts){const source=hosts.find(draft=>draft.id===host.id);if(!source||!this.options.grants.allows(host.path,source.accessToken,actor.userId))throw new StorageContractError('FORBIDDEN');}
        return drafts.map(draft=>{const value=(draft.kind==='host_file'?result.hosts:result.uploads).find(item=>item.id===draft.id);if(!value)throw new StorageContractError('STORAGE_UNAVAILABLE');return value;});
      });
    }finally{for(const host of hosts)this.options.grants.revoke(host.accessToken,actor.userId);}
  }
  async prepareEngineInput(claim:QueueClaim,payload:StoredClaimedTurn,signal:AbortSignal):Promise<string>{
    let metadata:unknown;try{metadata=JSON.parse(payload.message.metadata??'{}');}catch{throw new StorageContractError('INVALID_ARGUMENT');}
    const attachments=MessageAttachmentDtoSchema.array().max(10).parse((metadata as {attachments?:unknown})?.attachments??[]);
    if(!attachments.length)return payload.message.content;
    const physicalRoot=await fs.realpath(payload.session.projectPath);
    const guard=async()=>{if(this.closed||signal.aborted)throw new StorageContractError('NOT_SUBMITTED');await this.options.assertExclusiveWriter();
      if(await fs.realpath(payload.session.projectPath)!==physicalRoot)throw new StorageContractError('CONFLICT');
      if(!await this.options.port.checkQueueDispatch({principal:{kind:'system',purpose:'scheduler'},claim,sourceDigest:payload.sourceDigest}))throw new StorageContractError('CONFLICT');};
    const scope:UploadReadScope={projectId:payload.session.projectId,projectPath:payload.session.projectPath,ownerUserId:payload.session.ownerUserId,viewerUserId:claim.requestedByUserId,viewerRole:'member',active:true,revision:payload.sourceDigest};
    await this.options.files.withMutation(scope,guard,async ownedSignal=>{
      await this.options.promoter.inspect({projectPath:physicalRoot,projectId:scope.projectId,userId:claim.requestedByUserId,messageId:payload.message.id,attachments},async()=>{await guard();return true;},ownedSignal);
      await guard();
    });
    const text=payload.message.content.trim(),heading=text?'附件文件（Relay 主机绝对路径）：':'请查看以下附件文件（Relay 主机绝对路径）：';
    return `${text?text+'\n\n':''}${heading}\n${attachments.map(item=>'- '+item.path).join('\n')}`;
  }
  close(){this.closed=true;}
}
