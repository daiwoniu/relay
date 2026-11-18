import { parentPort,workerData } from 'node:worker_threads';
import { inspectPackage } from './package.js';
import { HostingError } from './errors.js';

try{parentPort!.postMessage({value:await inspectPackage(workerData)});}
catch(error){parentPort!.postMessage({error:error instanceof HostingError?error.message:'文件处理失败，请检查文件类型或压缩包结构',status:error instanceof HostingError?error.status:400});}
