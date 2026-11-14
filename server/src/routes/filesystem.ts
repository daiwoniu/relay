import { listProjectsForActor } from '../db/queries.js';
import { visibleOwnerUserId } from '../auth/authorization.js';
import { fileAccessGrants } from '../file-access.js';
import { createFilesystemCore } from './filesystem-core.js';
export * from './filesystem-core.js';
export default createFilesystemCore({grants:fileAccessGrants,getAllowedProjectRoots:async actor=>{
  try{return listProjectsForActor(visibleOwnerUserId(actor)).map(project=>project.path);}catch{return[];}
}});
