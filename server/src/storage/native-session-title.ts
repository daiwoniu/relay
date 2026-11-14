import type { nativeQueries } from './native-queries.js';
import { classifySessionTitleMessage,generateSessionTitle,shouldUpdateAutomaticSessionTitle } from '../session-title.js';
import { parseMessageMetadata } from '../message-metadata.js';

/** Called inside the accepted user-message transaction. Explicit and task-fixed titles remain authoritative. */
export function updateAcceptedAutomaticTitle(db:ReturnType<typeof nativeQueries>,sessionId:string,content:string,metadata:string|null,now:number){
  const row=db.get('SELECT title,title_manually_set FROM sessions WHERE id=?',[sessionId]);
  if(!row||Number(row.title_manually_set)!==0)return;
  const attachment=parseMessageMetadata(metadata).attachments?.[0],source=content.trim()||(attachment?`查看文件 ${attachment.name}`:'');
  const candidate=classifySessionTitleMessage(source);
  if(!shouldUpdateAutomaticSessionTitle(String(row.title),candidate.kind))return;
  const title=generateSessionTitle(candidate.content);if(title!==row.title)db.run('UPDATE sessions SET title=?,updated_at=? WHERE id=? AND title_manually_set=0',[title,now,sessionId]);
}
