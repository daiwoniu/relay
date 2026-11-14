import { parentPort,workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { promoteUploads,inspectPromotedAttachments } from './upload-promotion-journal.js';
import { StorageContractError } from '../storage/command-boundary.js';
const requestId=workerData.requestId;
const mayWrite=()=>new Promise<boolean>(resolve=>{
  const permissionId=randomUUID();const receive=(message:any)=>{if(message?.requestId!==requestId||message.permissionId!==permissionId)return;parentPort!.off('message',receive);resolve(message.allowed===true);};
  parentPort!.on('message',receive);parentPort!.postMessage({requestId,permissionId});
});
try{if(!await mayWrite())throw new StorageContractError('FORBIDDEN');const result=workerData.mode==='inspect'?await inspectPromotedAttachments(workerData.input):await promoteUploads(workerData.input,mayWrite);parentPort!.postMessage({requestId,result});}
catch(error){parentPort!.postMessage({requestId,error:error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE'});}
parentPort!.close();
